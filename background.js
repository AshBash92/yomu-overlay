// Background service worker: handles hotkeys, takes the screenshot,
// calls Claude, and hands the result to the content script.

import { translateImage, ApiError } from "./claude.js";
import { getSettings } from "./settings.js";

// Longest screenshot edge sent to Claude. Larger images cost more and
// take longer without reading small manga text noticeably better.
const MAX_IMAGE_EDGE = 2000;

const busyTabs = new Set();

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ??= await getActiveTab();
  if (!tab) return;
  if (command === "translate-visible") translateTab(tab);
  if (command === "toggle-overlay") sendToTab(tab.id, { type: "toggle" });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "popup-translate") translateTab(msg.tab);
  if (msg.type === "popup-toggle") sendToTab(msg.tab.id, { type: "toggle" });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

async function translateTab(tab) {
  if (busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
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

    // Clear old overlays first so they don't end up in the screenshot,
    // and remember the scroll position the screenshot was taken at.
    const view = await chrome.tabs.sendMessage(tab.id, { type: "prepare-capture" });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 90 });
    await sendToTab(tab.id, { type: "loading" });

    const image = await shrinkImage(dataUrl, MAX_IMAGE_EDGE);
    const result = await translateImage({ ...settings, image });

    await sendToTab(tab.id, { type: "render", regions: result.regions ?? [], view });
    setBadge(tab.id, "");
  } catch (err) {
    console.error("Yomu translate failed:", err);
    const message = err instanceof ApiError ? err.message : `Something went wrong: ${err.message}`;
    await sendToTab(tab.id, { type: "error", message });
    setBadge(tab.id, "!", "#c62828", message);
  } finally {
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
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) {
    bitmap.close();
    return { mediaType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return { mediaType: "image/jpeg", data: await blobToBase64(out) };
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
