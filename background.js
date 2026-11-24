// Background service worker: handles hotkeys, takes the screenshot,
// calls Claude, and hands each bubble to the content script as it arrives.

import { translateImage, breakdownLine, ApiError } from "./claude.js";
import { getSettings } from "./settings.js";
import { openPanel } from "./panel-open.js";
import { formatCost } from "./usage.js";
import { getKnown, isKnown, kanjiInKnownWords } from "./known.js";
import { kanjiUpTo, isKanji } from "./jlpt.js";
import { saveWord, sourceUrl } from "./wordlist.js";

// Longest screenshot edge sent to Claude. Larger images cost more and
// take longer without reading small manga text noticeably better.
const MAX_IMAGE_EDGE = 2000;

// Translations in progress: tab id -> AbortController.
const running = new Map();

// Keep the API key and word lists away from content scripts, which run
// inside web pages and don't need them.
chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((err) => console.warn("[yomu] couldn't restrict storage:", err));

chrome.commands.onCommand.addListener(async (command, tab) => {
  // Must run before any await: the side panel only opens in direct
  // response to the keypress.
  if (command === "open-study-panel" && tab) {
    openPanel(tab.windowId).catch((err) => console.warn("[yomu] couldn't open panel:", err));
    return;
  }
  tab ??= await getActiveTab();
  if (!tab) return;
  if (command === "translate-visible") translateTab(tab);
  if (command === "toggle-overlay") sendToTab(tab.id, { type: "toggle" });
  if (command === "reveal-english") sendToTab(tab.id, { type: "reveal" });
});

// Tags each word so the page can decide where furigana goes:
// hasKanji, aboveLevel (has a kanji you don't know yet), known (word
// is in your known list).
export async function furiganaTagger(level) {
  const known = await getKnown();
  const knownKanji = new Set([...kanjiUpTo(level), ...kanjiInKnownWords(known)]);
  return (region) => {
    if (!Array.isArray(region.segments)) return region;
    region.segments = region.segments.map((s) => {
      const kanji = [...(s.text ?? "")].filter(isKanji);
      return {
        text: s.text ?? "",
        reading: kanji.length ? s.reading ?? "" : "",
        dictionaryForm: s.dictionaryForm ?? "",
        hasKanji: kanji.length > 0,
        aboveLevel: kanji.some((k) => !knownKanji.has(k)),
        known: isKnown(known, { word: s.text, dictionaryForm: s.dictionaryForm }),
      };
    });
    return region;
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  // The study panel may run in its own window, so it names the tab it's
  // studying. Content scripts can only ever act on their own tab.
  const fromExtensionPage = Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
  if (msg.type === "study-update") {
    const tabId = fromExtensionPage ? msg.tabId : sender.tab?.id;
    if (!Number.isInteger(tabId)) return;
    updateStudy(tabId, msg).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true; // async response
  }
  if (msg.type === "word-help" && sender.tab && !fromExtensionPage) {
    wordHelp(sender.tab.id, msg.pageId, msg.index).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "open-panel" && sender.tab && !fromExtensionPage) {
    openPanel(sender.tab.windowId).then(
      () => sendResponse({ opened: true }),
      () => sendResponse({ opened: false })
    );
    return true; // async response
  }

  // Extension pages have no sender.tab. Content scripts do, and they run
  // inside web pages, so they can't start a translation or name a tab.
  if (!sender.tab) {
    if (msg.type === "popup-translate") translateTab(msg.tab);
    if (msg.type === "popup-toggle") sendToTab(msg.tab.id, { type: "toggle" });
    if (msg.type === "popup-auto") autoFromPopup(msg.tab);
    return;
  }
  if (!fromExtensionPage) {
    const autoRequest =
      msg.type === "auto-translate" ? runAuto(sender.tab.id)
      : msg.type === "auto-toggle" ? toggleAuto(sender.tab.id, msg.on === true)
      : msg.type === "auto-remember" ? queueRemember(sender.tab.id, msg)
      : null;
    if (autoRequest) {
      autoRequest.then(sendResponse, () => sendResponse({ error: true }));
      return true; // async response
    }
  }
  if (msg.type === "cancel-translation") running.get(sender.tab.id)?.abort();
  if (msg.type === "focus-region" && Number.isInteger(msg.index)) {
    // Ctrl+click on a bubble: tell the panel which one, and open it.
    chrome.storage.session.set({ focus: { tabId: sender.tab.id, index: msg.index, at: Date.now() } });
    openPanel(sender.tab.windowId).then(
      () => sendResponse({ opened: true }),
      () => sendResponse({ opened: false })
    );
    return true; // async response
  }
});

// Forget a tab's bubbles when it closes.
chrome.tabs.onRemoved.addListener((tabId) =>
  chrome.storage.session.remove([`tab:${tabId}`, `study:${tabId}`, autoKey(tabId), autoCacheKey(tabId)])
);

// ---------- Read-first study progress ----------
// Which bubbles you've revealed and how you rated them. The overlay and the
// study panel both go through here, so they stay in step.

const RATINGS = new Set(["got", "partly", "missed"]);
let studyQueue = Promise.resolve();

// One at a time, since each update reads and rewrites stored lists.
function updateStudy(tabId, update) {
  const run = () => applyStudy(tabId, update);
  const next = studyQueue.then(run, run);
  studyQueue = next.catch(() => {});
  return next;
}

async function applyStudy(tabId, { pageId, indices, english, rating, look }) {
  const pageKey = `tab:${tabId}`;
  const studyKey = `study:${tabId}`;
  const stored = await chrome.storage.session.get([pageKey, studyKey]);
  const page = stored[pageKey];
  if (!page || page.id !== pageId || !Array.isArray(indices)) return;
  const study = stored[studyKey]?.pageId === pageId ? stored[studyKey] : { pageId, bubbles: {} };
  const validLook = typeof look === "string" && look.length > 0 && look.length <= 64;
  const toSave = [];

  for (const i of indices) {
    const region = Number.isInteger(i) ? page.regions[i] : null;
    if (!region) continue;
    const bubble = (study.bubbles[i] ??= { english: false, rating: null, looked: [] });
    if (english === true) bubble.english = true;
    if (validLook && !bubble.looked.includes(look)) bubble.looked.push(look);
    if (RATINGS.has(rating)) {
      bubble.english = true;
      bubble.rating = rating;
    }
    // Words you needed on a line you didn't fully get are worth reviewing.
    if ((RATINGS.has(rating) || validLook) && bubble.rating && bubble.rating !== "got") {
      toSave.push({ region, looked: bubble.looked });
    }
  }

  await chrome.storage.session.set({ [studyKey]: study });
  for (const { region, looked } of toSave) await saveLookedUp(page, region, looked);
  sendToTab(tabId, { type: "study-sync", pageId, bubbles: study.bubbles });
}

async function saveLookedUp(page, region, looked) {
  if (!looked.length) return;
  const { level } = await getSettings();
  const key = `bd:${level}:${region.japanese}`;
  const breakdown = (await chrome.storage.session.get(key))[key];
  for (const word of looked) {
    const entry = breakdown?.words?.find((w) => w.word === word);
    if (!entry) continue;
    await saveWord({
      ...entry,
      sentence: region.japanese,
      sentenceEnglish: region.english,
      source: sourceUrl(page.url),
    });
  }
}

// Word help for one bubble. Only lines from this tab's translation can be
// looked up, so a web page can't use this to spend the reader's API credit.
const wordHelpRequests = new Map();

async function wordHelp(tabId, pageId, index) {
  const pageKey = `tab:${tabId}`;
  const page = (await chrome.storage.session.get(pageKey))[pageKey];
  const region = page?.id === pageId && Number.isInteger(index) ? page.regions[index] : null;
  if (!region) return { error: "That bubble is no longer on this page. Translate it again." };

  const settings = await getSettings();
  const storeKey = `bd:${settings.level}:${region.japanese}`;
  const stored = (await chrome.storage.session.get(storeKey))[storeKey];
  if (stored) return { words: stored.words };
  if (!settings.apiKey) return { error: "Add your API key on the options page first." };

  if (!wordHelpRequests.has(storeKey)) {
    const stopKeepAlive = keepAlive();
    const start = Math.max(0, index - 2);
    const nearby = page.regions
      .slice(start, index + 3)
      .filter((_, j) => start + j !== index)
      .map((r) => r.japanese);
    const request = breakdownLine({ ...settings, line: region.japanese, english: region.english, nearby })
      .then(async (value) => {
        await chrome.storage.session.set({ [storeKey]: value }).catch(() => {});
        return value;
      })
      .finally(() => {
        stopKeepAlive();
        wordHelpRequests.delete(storeKey);
      });
    wordHelpRequests.set(storeKey, request);
  }
  try {
    return { words: (await wordHelpRequests.get(storeKey)).words };
  } catch (err) {
    return { error: err.message };
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

// Brave/Chrome stop an idle extension worker after 30 seconds. Calling any
// extension API resets that clock, so ping one while a request is running.
function keepAlive() {
  const id = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  return () => clearInterval(id);
}

const ms = (n) => `${(n / 1000).toFixed(1)}s`;

async function translateTab(tab, { auto = false } = {}) {
  if (running.has(tab.id)) return;
  const abort = new AbortController();
  running.set(tab.id, abort);
  const stopKeepAlive = keepAlive();
  setBadge(tab.id, "…", "#555");

  try {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch {
      if (auto) {
        await endAuto(tab.id);
        await sendToTab(tab.id, { type: "error", message: "Auto-translate stopped. Press Alt+T to start it again." });
        setBadge(tab.id, "");
        return;
      }
      setBadge(tab.id, "!", "#c62828", "Yomu can't run on this page (browser pages and extension stores are blocked).");
      return;
    }

    const settings = await getSettings();
    if (!settings.apiKey) {
      await sendToTab(tab.id, { type: "error", message: "No API key yet. Opening the options page so you can add one." });
      chrome.runtime.openOptionsPage();
      setBadge(tab.id, "");
      return;
    }

    if (!auto && autoEnabled(settings)) await startAuto(tab);

    const t0 = performance.now();
    // Clear old overlays first so they don't end up in the screenshot,
    // and remember the scroll position the screenshot was taken at.
    const view = await chrome.tabs.sendMessage(tab.id, { type: "prepare-capture", auto });
    if (view?.skip) {
      setBadge(tab.id, "");
      return;
    }
    // captureVisibleTab takes whatever tab is showing, so an automatic capture
    // must confirm it's still this one, both before and after.
    const showing = auto ? await chrome.tabs.get(tab.id).catch(() => null) : tab;
    if (auto && !showing?.active) return cancelCapture(tab.id);
    const dataUrl = await chrome.tabs.captureVisibleTab(showing.windowId, { format: "jpeg", quality: 90 });
    if (auto) {
      const after = await chrome.tabs.get(tab.id).catch(() => null);
      if (!after?.active || after.windowId !== showing.windowId) return cancelCapture(tab.id);
    }
    const tCapture = performance.now();
    const pageId = Date.now();
    await sendToTab(tab.id, {
      type: "start",
      pageId,
      view,
      showSfx: settings.showSfx,
      display: { mode: settings.displayMode, furigana: settings.furigana },
      autoAvailable: autoEnabled(settings),
    });
    // Readings cost extra output, so only ask for them when Japanese is shown.
    const withReadings = settings.displayMode !== "english";
    const tag = await furiganaTagger(settings.level);

    const image = await prepareImage(dataUrl, view, MAX_IMAGE_EDGE);
    const tShrink = performance.now();

    // Kept in session storage so the study panel can list the bubbles.
    const pageKey = `tab:${tab.id}`;
    const page = { id: pageId, url: tab.url ?? "", translatedAt: Date.now(), regions: [] };
    await chrome.storage.session.set({ [pageKey]: page, [`study:${tab.id}`]: { pageId, bubbles: {} } });

    const { regions, stopReason, stats } = await translateImage({
      ...settings,
      withReadings,
      image,
      signal: abort.signal,
      onRegion: (region) => {
        tag(region);
        const index = page.regions.length;
        page.regions.push(region);
        sendToTab(tab.id, { type: "region", region, index });
        chrome.storage.session.set({ [pageKey]: page }).catch(() => {});
      },
    });

    const totalMs = performance.now() - t0;
    console.log(
      `[yomu] ${regions.length} regions in ${ms(totalMs)} | ` +
        `capture ${ms(tCapture - t0)}, resize ${ms(tShrink - tCapture)} (${image.width}x${image.height}), ` +
        `Claude first byte ${ms(stats.firstByteMs)}, first bubble ${ms(stats.firstRegionMs)}, done ${ms(stats.totalMs)} | ` +
        `${stats.model}, effort ${settings.effort}, ${stats.inputTokens} in / ${stats.outputTokens} out tokens, ~${formatCost(stats.cost)}, stop: ${stopReason}`
    );

    const note = stopReason === "max_tokens" ? " Some text was cut off; zoom in and try again." : "";
    await sendToTab(tab.id, {
      type: "done",
      count: regions.length,
      seconds: totalMs / 1000,
      cost: stats.cost == null ? "" : formatCost(stats.cost),
      note,
    });
    setBadge(tab.id, "");
  } catch (err) {
    if (err.kind === "cancelled") {
      setBadge(tab.id, "");
      return;
    }
    console.error("[yomu] translate failed:", err);
    // Never retry on its own: a bad key or empty balance would just keep failing.
    const hadAuto = await endAuto(tab.id);
    const reason = err instanceof ApiError ? err.message : `Something went wrong: ${err.message}`;
    const message = hadAuto ? `${reason} Auto-translate is off for this tab. Press Alt+T to start it again.` : reason;
    await sendToTab(tab.id, { type: "error", message });
    setBadge(tab.id, "!", "#c62828", message);
  } finally {
    stopKeepAlive();
    running.delete(tab.id);
  }
}

async function cancelCapture(tabId) {
  await sendToTab(tabId, { type: "capture-cancelled" });
  setBadge(tabId, "");
}

// ---------- Auto-translate ----------
// Optional, English mode only. It starts on a tab when you translate it, stays
// on that site, and only sends manga images from the tab you're looking at.

const AUTO_PAGE_LIMIT = 30; // pages in a row before asking to keep going
const AUTO_GAP_MS = 1500; // also stays under the browser's capture rate limit
const AUTO_CACHE_IMAGES = 80; // translated images remembered per tab

const autoStarting = new Set();
let lastAutoAt = 0;
let rememberQueue = Promise.resolve();

function autoKey(tabId) {
  return `auto:${tabId}`;
}
function autoCacheKey(tabId) {
  return `autocache:${tabId}`;
}
const autoEnabled = (settings) => settings.autoTranslate && settings.displayMode === "english";

function originOf(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function sendAutoOn(tabId, settings, images) {
  return sendToTab(tabId, {
    type: "auto-state",
    on: true,
    available: true,
    images,
    showSfx: settings.showSfx,
    display: { mode: settings.displayMode, furigana: settings.furigana },
  });
}

async function startAuto(tab) {
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  const origin = originOf(current?.url);
  if (!origin) return false;
  const key = autoKey(tab.id);
  const cacheKey = autoCacheKey(tab.id);
  const [stored, settings] = await Promise.all([chrome.storage.session.get(cacheKey), getSettings()]);
  const cache = stored[cacheKey]?.origin === origin ? stored[cacheKey] : { origin, images: {} };
  await chrome.storage.session.set({ [key]: { origin, count: 0 }, [cacheKey]: cache });
  await sendAutoOn(tab.id, settings, cache.images);
  return true;
}

// Returns whether auto-translate was running on this tab.
async function endAuto(tabId, available = true) {
  const key = autoKey(tabId);
  const wasOn = Boolean((await chrome.storage.session.get(key))[key]);
  if (wasOn) await chrome.storage.session.remove(key);
  await sendToTab(tabId, { type: "auto-state", on: false, available });
  return wasOn;
}

async function toggleAuto(tabId, on) {
  if (!on) {
    await endAuto(tabId);
    return { on: false };
  }
  const settings = await getSettings();
  if (!autoEnabled(settings) || !settings.apiKey) return { on: false };
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { on: Boolean(tab && (await startAuto(tab))) };
}

// Turned on from the popup: start now if this tab already has a translation.
async function autoFromPopup(tab) {
  if (!Number.isInteger(tab?.id)) return;
  const pageKey = `tab:${tab.id}`;
  const [settings, stored] = await Promise.all([getSettings(), chrome.storage.session.get(pageKey)]);
  if (autoEnabled(settings) && settings.apiKey && stored[pageKey]) await startAuto(tab);
}

async function runAuto(tabId) {
  if (running.has(tabId) || autoStarting.has(tabId)) return { busy: true };
  autoStarting.add(tabId);
  try {
    const key = autoKey(tabId);
    const session = (await chrome.storage.session.get(key))[key];
    if (!session) return { on: false };
    const settings = await getSettings();
    if (!autoEnabled(settings) || !settings.apiKey) {
      await endAuto(tabId, false);
      return { on: false };
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active) return { waiting: true };
    if (originOf(tab.url) !== session.origin) {
      await endAuto(tabId);
      return { on: false };
    }
    if (session.count >= AUTO_PAGE_LIMIT) {
      await endAuto(tabId);
      return { limit: AUTO_PAGE_LIMIT };
    }
    const wait = lastAutoAt + AUTO_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAutoAt = Date.now();
    await chrome.storage.session.set({ [key]: { ...session, count: session.count + 1 } });
    translateTab(tab, { auto: true });
    return { started: true };
  } finally {
    autoStarting.delete(tabId);
  }
}

function queueRemember(tabId, update) {
  const run = () => rememberImages(tabId, update);
  const next = rememberQueue.then(run, run);
  rememberQueue = next.catch(() => {});
  return next;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [top, bottom] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && top <= last[1]) last[1] = Math.max(last[1], bottom);
    else merged.push([top, bottom]);
  }
  return merged;
}

// Saves which part of each image was translated, so going back to a page
// costs nothing. Text comes from this tab's stored translation, not the page.
async function rememberImages(tabId, { pageId, images }) {
  const pageKey = `tab:${tabId}`;
  const key = autoKey(tabId);
  const cacheKey = autoCacheKey(tabId);
  const stored = await chrome.storage.session.get([pageKey, key, cacheKey]);
  const page = stored[pageKey];
  const cache = stored[cacheKey];
  if (!stored[key] || !cache || page?.id !== pageId || !Array.isArray(images)) return { images: {} };

  const updated = {};
  for (const image of images.slice(0, 8)) {
    const { key: imageId, top, bottom, boxes } = image ?? {};
    if (typeof imageId !== "string" || !imageId || imageId.length > 512) continue;
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom > 1 || top > bottom) continue;
    if (!Array.isArray(boxes)) continue;
    const fresh = [];
    for (const { index, x, y, w, h } of boxes) {
      const region = Number.isInteger(index) ? page.regions[index] : null;
      if (!region || ![x, y, w, h].every(Number.isFinite)) continue;
      fresh.push({ region: { kind: region.kind, japanese: region.japanese, english: region.english }, x, y, w, h });
    }
    const entry = cache.images[imageId] ?? { ranges: [], boxes: [] };
    const kept = entry.boxes.filter((b) => {
      const middle = b.y + b.h / 2;
      return middle < top || middle > bottom;
    });
    const next = { ranges: mergeRanges([...entry.ranges, [top, bottom]]), boxes: [...kept, ...fresh] };
    delete cache.images[imageId]; // moves it to the newest position
    cache.images[imageId] = next;
    updated[imageId] = next;
  }
  const names = Object.keys(cache.images);
  for (const name of names.slice(0, Math.max(0, names.length - AUTO_CACHE_IMAGES))) delete cache.images[name];
  await chrome.storage.session.set({ [cacheKey]: cache });
  return { images: updated };
}

// Readers that load a whole new document per page lose the content script,
// so put it back. Going to a different site ends auto-translate.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const key = autoKey(tabId);
  const session = (await chrome.storage.session.get(key))[key];
  if (!session) return;
  const [settings, tab] = await Promise.all([getSettings(), chrome.tabs.get(tabId).catch(() => null)]);
  if (!tab || !autoEnabled(settings) || originOf(tab.url) !== session.origin) {
    await chrome.storage.session.remove(key);
    return;
  }
  try {
    const [{ result: alive }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__yomuOverlay),
    });
    if (!alive) {
      running.get(tabId)?.abort(); // that translation was for the old document
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    }
  } catch {
    await chrome.storage.session.remove(key);
    setBadge(tabId, "!", "#c62828", "Auto-translate stopped. Press Alt+T to start it again.");
    return;
  }
  const cacheKey = autoCacheKey(tabId);
  const cache = (await chrome.storage.session.get(cacheKey))[cacheKey];
  await sendAutoOn(tabId, settings, cache?.origin === session.origin ? cache.images : {});
});

// Turning it off, or leaving English mode, stops it everywhere right away.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.autoTranslate || changes.displayMode)) return;
  if (autoEnabled(await getSettings())) return;
  const stored = await chrome.storage.session.get(null);
  for (const key of Object.keys(stored)) {
    if (key.startsWith("auto:")) await endAuto(Number(key.slice(5)), false);
  }
});

function setBadge(tabId, text, color, title) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setTitle({ tabId, title: title ? `Yomu Overlay: ${title}` : "Yomu Overlay" }).catch(() => {});
}

// Crops the screenshot to the manga (view.crop, in CSS pixels) so the rest
// of the tab is never sent, then shrinks it to maxEdge.
async function prepareImage(dataUrl, view, maxEdge) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const pxX = width / view.width;
  const pxY = height / view.height;
  const sx = Math.max(0, Math.round(view.crop.left * pxX));
  const sy = Math.max(0, Math.round(view.crop.top * pxY));
  const sw = Math.min(width - sx, Math.round(view.crop.width * pxX));
  const sh = Math.min(height - sy, Math.round(view.crop.height * pxY));
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  if (scale === 1 && sw === width && sh === height) {
    bitmap.close();
    return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), width, height };
  }
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return { mediaType: "image/jpeg", data: await blobToBase64(out), width: canvas.width, height: canvas.height };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
