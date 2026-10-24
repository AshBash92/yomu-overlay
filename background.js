// Background service worker: handles hotkeys, takes the screenshot,
// calls Claude, and hands each bubble to the content script as it arrives.

import { translateImage, ApiError } from "./claude.js";
import { getSettings } from "./settings.js";
import { openPanel } from "./panel-open.js";
import { formatCost } from "./usage.js";
import { getKnown, isKnown, kanjiInKnownWords } from "./known.js";
import { kanjiUpTo, isKanji } from "./jlpt.js";

// Longest screenshot edge sent to Claude. Larger images cost more and
// take longer without reading small manga text noticeably better.
const MAX_IMAGE_EDGE = 2000;

const busyTabs = new Set();

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
  if (msg.type === "popup-translate") translateTab(msg.tab);
  if (msg.type === "popup-toggle") sendToTab(msg.tab.id, { type: "toggle" });
  if (msg.type === "focus-region" && sender.tab) {
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
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`tab:${tabId}`));

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

async function translateTab(tab) {
  if (busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  const stopKeepAlive = keepAlive();
  setBadge(tab.id, "…", "#555");

  try {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch {
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

    const t0 = performance.now();
    // Clear old overlays first so they don't end up in the screenshot,
    // and remember the scroll position the screenshot was taken at.
    const view = await chrome.tabs.sendMessage(tab.id, { type: "prepare-capture" });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 });
    const tCapture = performance.now();
    await sendToTab(tab.id, {
      type: "start",
      view,
      showSfx: settings.showSfx,
      display: { mode: settings.displayMode, furigana: settings.furigana },
    });
    // Readings cost extra output, so only ask for them when Japanese is shown.
    const withReadings = settings.displayMode !== "english";
    const tag = await furiganaTagger(settings.level);

    const image = await shrinkImage(dataUrl, MAX_IMAGE_EDGE);
    const tShrink = performance.now();

    // Kept in session storage so the study panel can list the bubbles.
    const pageKey = `tab:${tab.id}`;
    const page = { id: Date.now(), url: tab.url ?? "", translatedAt: Date.now(), regions: [] };
    await chrome.storage.session.set({ [pageKey]: page });

    const { regions, stopReason, stats } = await translateImage({
      ...settings,
      withReadings,
      image,
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
    console.error("[yomu] translate failed:", err);
    const message = err instanceof ApiError ? err.message : `Something went wrong: ${err.message}`;
    await sendToTab(tab.id, { type: "error", message });
    setBadge(tab.id, "!", "#c62828", message);
  } finally {
    stopKeepAlive();
    busyTabs.delete(tab.id);
  }
}

function setBadge(tabId, text, color, title) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setTitle({ tabId, title: title ? `Yomu Overlay: ${title}` : "Yomu Overlay" }).catch(() => {});
}

async function shrinkImage(dataUrl, maxEdge) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) {
    bitmap.close();
    return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), width, height };
  }
  const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
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
