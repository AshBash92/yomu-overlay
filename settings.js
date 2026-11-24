// Shared settings helpers. Everything lives in chrome.storage.local,
// which stays on this computer and is never synced.

export const DEFAULTS = {
  apiKey: "",
  model: "claude-haiku-5-5",
  effort: "medium",
  showSfx: false, // translate sound effects / onomatopoeia
  level: "N4", // learner's JLPT level
  displayMode: "study", // "study" (read first, ask for hints) | "english"
  furigana: "above-level", // "above-level" | "unknown-words" | "off"
  autoTranslate: false, // English mode: translate new pages as you reach them
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  // Older versions had separate "read-first" and "hover" modes.
  if (settings.displayMode !== "english") settings.displayMode = "study";
  return settings;
}

export async function saveSettings(values) {
  await chrome.storage.local.set(values);
}
