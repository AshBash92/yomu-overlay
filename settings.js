// Shared settings helpers. Everything lives in chrome.storage.local,
// which stays on this computer and is never synced.

export const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(values) {
  await chrome.storage.local.set(values);
}
