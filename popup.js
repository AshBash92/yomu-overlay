import { getSettings, saveSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

$("translate").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "popup-translate", tab: await activeTab() });
  window.close();
});

$("toggle").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "popup-toggle", tab: await activeTab() });
  window.close();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

const commands = await chrome.commands.getAll();
for (const c of commands) {
  const label = c.shortcut || "not set";
  if (c.name === "translate-visible") $("translate-key").textContent = label;
  if (c.name === "toggle-overlay") $("toggle-key").textContent = label;
}

const { apiKey, showSfx } = await getSettings();

$("showSfx").checked = showSfx;
$("showSfx").addEventListener("change", async (e) => {
  const show = e.target.checked;
  await saveSettings({ showSfx: show });
  // Hide or show sound-effect boxes already on the page.
  const tab = await activeTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "set-sfx", show }).catch(() => {});
});

$("key").textContent = apiKey ? "API key saved." : "No API key yet. Add one in Options.";
$("key").classList.toggle("missing", !apiKey);
