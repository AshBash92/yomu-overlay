import { getSettings, saveSettings } from "./settings.js";
import { openPanel } from "./panel-open.js";
import { getSpend, formatCost } from "./usage.js";

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

// Looked up now so the click handler can open the panel without waiting
// (the side panel only opens in direct response to a click).
let windowId = null;
chrome.windows.getCurrent().then((w) => (windowId = w.id));

$("study").addEventListener("click", async () => {
  await openPanel(windowId).catch((err) => console.warn("Yomu: couldn't open panel", err));
  window.close();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

const commands = await chrome.commands.getAll();
for (const c of commands) {
  const label = c.shortcut || "not set";
  if (c.name === "translate-visible") $("translate-key").textContent = label;
  if (c.name === "toggle-overlay") $("toggle-key").textContent = label;
  if (c.name === "open-study-panel") $("study-key").textContent = label;
  if (c.name === "reveal-english") $("reveal-key").textContent = label;
}

const { apiKey, showSfx, model, displayMode, furigana } = await getSettings();

// Display mode and furigana: save, then update bubbles already on the page.
async function applyDisplay() {
  const mode = document.querySelector("input[name=mode]:checked").value;
  const fur = $("furigana").value;
  $("furigana-row").hidden = $("reveal-hint").hidden = mode === "english";
  await saveSettings({ displayMode: mode, furigana: fur });
  const tab = await activeTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "set-display", mode, furigana: fur }).catch(() => {});
}
document.querySelector(`input[name=mode][value="${displayMode}"]`).checked = true;
$("furigana").value = furigana;
$("furigana-row").hidden = $("reveal-hint").hidden = displayMode === "english";
for (const input of document.querySelectorAll("input[name=mode]")) input.addEventListener("change", applyDisplay);
$("furigana").addEventListener("change", applyDisplay);

const spend = await getSpend();
const modelName = model.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2");
$("spend").textContent =
  `Using ${modelName}. This month: about ${formatCost(spend.total)} ` +
  `(${spend.requests} request${spend.requests === 1 ? "" : "s"}).`;

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
