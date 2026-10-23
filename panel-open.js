// Opens the study panel. Uses the browser's side panel when available,
// otherwise a small separate window.
//
// The side panel may only be opened in direct response to a user action
// (click or hotkey), so call this before awaiting anything else.

export function openPanel(windowId) {
  if (chrome.sidePanel?.open) return chrome.sidePanel.open({ windowId });
  return openPanelWindow();
}

async function openPanelWindow() {
  const url = chrome.runtime.getURL("panel.html");
  const [existing] = await chrome.runtime.getContexts({ documentUrls: [url] });
  if (existing?.windowId > 0) return chrome.windows.update(existing.windowId, { focused: true });
  return chrome.windows.create({ url, type: "popup", width: 420, height: 820 });
}
