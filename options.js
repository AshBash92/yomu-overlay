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
