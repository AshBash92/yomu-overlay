import { getSettings, saveSettings } from "./settings.js";
import { testApiKey } from "./claude.js";

const $ = (id) => document.getElementById(id);

function say(text, kind = "") {
  $("message").textContent = text;
  $("message").className = kind;
}

const settings = await getSettings();
$("apiKey").value = settings.apiKey;
$("model").value = settings.model;
$("effort").value = settings.effort;
$("level").value = settings.level;

// Saved right away, so it can't overwrite a change made in the popup.
document.querySelector(`input[name=mode][value="${settings.displayMode}"]`).checked = true;
function showControlsFor(mode) {
  $("learner").hidden = mode === "english";
  $("auto-row").hidden = mode !== "english";
}
showControlsFor(settings.displayMode);
for (const input of document.querySelectorAll("input[name=mode]")) {
  input.addEventListener("change", async () => {
    showControlsFor(input.value);
    await saveSettings({ displayMode: input.value });
    say("Reading mode saved.", "ok");
  });
}
$("autoTranslate").checked = settings.autoTranslate;
$("autoTranslate").addEventListener("change", async (e) => {
  await saveSettings({ autoTranslate: e.target.checked });
  say(e.target.checked ? "Auto-translate is on." : "Auto-translate is off.", "ok");
});

$("reveal").addEventListener("click", () => {
  const hidden = $("apiKey").type === "password";
  $("apiKey").type = hidden ? "text" : "password";
  $("reveal").textContent = hidden ? "Hide" : "Show";
});

$("save").addEventListener("click", async () => {
  await saveSettings({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value,
    effort: $("effort").value,
    level: $("level").value,
  });
  say("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const key = $("apiKey").value.trim();
  if (!key) return say("Paste a key first.", "error");
  say("Testing…");
  try {
    await testApiKey(key);
    say("Key works. Remember to click Save.", "ok");
  } catch (err) {
    say(err.message, "error");
  }
});
