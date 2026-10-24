// Shared settings helpers. Everything lives in chrome.storage.local,
// which stays on this computer and is never synced.

export const DEFAULTS = {
  apiKey: "",
  model: "claude-haiku-5-5",
  effort: "medium",
  showSfx: false, // translate sound effects / onomatopoeia
  level: "N4", // learner's JLPT level
  displayMode: "english", // "english" | "read-first" | "hover"
  furigana: "above-level", // "above-level" | "unknown-words" | "off"
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(values) {
  await chrome.storage.local.set(values);
}
