// Study panel: lists the bubbles from the last translation of the current
// tab, loads word/kanji breakdowns and grammar notes on demand, and
// manages the saved word list.

import { getSettings } from "./settings.js";
import { breakdownLine, explainGrammar, ApiError } from "./claude.js";
import { getWords, saveWord, removeWord, clearWords, wordKey, wordsToCsv, kanjiText } from "./wordlist.js";

const $ = (id) => document.getElementById(id);

// Builds a DOM element. Text always goes in as text, never as HTML,
// since it comes from Claude and from web pages.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "lang") node.lang = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// ---------- State ----------

let tabId = null;
let page = null; // { id, url, translatedAt, regions }
let openIndex = -1;
let selectedWord = -1;
const breakdowns = new Map(); // japanese -> { status, data?, error? }
const grammars = new Map(); // japanese -> { status, text?, error? }
let savedKeys = new Set();
let words = [];

// ---------- Which tab are we studying? ----------

async function currentTab() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab ?? null;
  } catch {
    return null;
  }
}

async function loadPage() {
  const tab = await currentTab();
  tabId = tab?.id ?? null;
  const key = `tab:${tabId}`;
  const next = tabId == null ? null : (await chrome.storage.session.get(key))[key] ?? null;
  if (next?.id !== page?.id) {
    openIndex = -1;
    selectedWord = -1;
  }
  page = next;
  renderPage();
}

// ---------- Claude calls (cached for this browser session) ----------

// Up to two bubbles before and after, as context for Claude.
function nearby(i) {
  const start = Math.max(0, i - 2);
  return page.regions
    .slice(start, i + 3)
    .filter((_, j) => start + j !== i)
    .map((r) => r.japanese);
}

async function cachedCall(map, prefix, region, i, call) {
  const k = region.japanese;
  if (map.get(k)?.status === "loading" || map.get(k)?.status === "done") return;
  const storeKey = `${prefix}:${k}`;
  const stored = (await chrome.storage.session.get(storeKey))[storeKey];
  if (stored) {
    map.set(k, { status: "done", value: stored });
    renderPage();
    return;
  }
  map.set(k, { status: "loading" });
  renderPage();
  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new ApiError("auth", "Add your API key on the options page first.");
    const value = await call({ ...settings, line: k, english: region.english, nearby: nearby(i) });
    map.set(k, { status: "done", value });
    chrome.storage.session.set({ [storeKey]: value }).catch(() => {});
  } catch (err) {
    map.set(k, { status: "error", error: err.message });
  }
  renderPage();
}

const loadBreakdown = (i) => cachedCall(breakdowns, "bd", page.regions[i], i, breakdownLine);
const loadGrammar = (i) => cachedCall(grammars, "gr", page.regions[i], i, explainGrammar);

// ---------- Rendering: this page ----------

function renderPage() {
  const regions = page?.regions ?? [];
  $("page-empty").hidden = regions.length > 0;
  $("page-meta").hidden = !regions.length;
  if (page?.translatedAt) {
    const time = new Date(page.translatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    $("page-meta").textContent = `${regions.length} bubble${regions.length === 1 ? "" : "s"} · translated ${time}`;
  }
  $("bubbles").replaceChildren(...regions.map(renderBubble));
}

function renderBubble(region, i) {
  const open = i === openIndex;
  return el(
    "article",
    { class: open ? "bubble open" : "bubble", dataset: { index: i } },
    el(
      "header",
      { dataset: { action: "toggle" } },
      el("span", { class: "num" }, i + 1),
      el("div", {}, el("p", { class: "ja", lang: "ja" }, region.japanese), el("p", { class: "en" }, region.english))
    ),
    open && renderDetail(region)
  );
}

function renderDetail(region) {
  const bd = breakdowns.get(region.japanese);
  const gr = grammars.get(region.japanese);
  const parts = [];

  if (!bd || bd.status === "loading") {
    parts.push(el("p", { class: "loading" }, "Breaking down this line…"));
  } else if (bd.status === "error") {
    parts.push(
      el("p", { class: "error" }, bd.error, " "),
      el("button", { class: "btn", dataset: { action: "retry-breakdown" } }, "Try again")
    );
  } else {
    const { reading, words } = bd.value;
    parts.push(el("p", { class: "reading", lang: "ja" }, reading));
    parts.push(
      el(
        "div",
        { class: "words" },
        words.map((w, wi) =>
          el(
            "button",
            { class: wi === selectedWord ? "chip selected" : "chip", dataset: { action: "word", word: wi }, title: w.meaning },
            el("span", { class: "r", lang: "ja" }, w.word === w.reading ? " " : w.reading),
            el("span", { class: "w", lang: "ja" }, w.word)
          )
        )
      )
    );
    if (words[selectedWord]) parts.push(renderWordCard(words[selectedWord], region));
  }

  const actions = el("div", { class: "actions" });
  if (!gr || gr.status === "error") {
    actions.append(el("button", { class: "btn", dataset: { action: "grammar" } }, "Explain grammar"));
  }
  parts.push(actions);
  if (gr?.status === "loading") parts.push(el("p", { class: "loading" }, "Explaining the grammar…"));
  if (gr?.status === "error") parts.push(el("p", { class: "error" }, gr.error));
  if (gr?.status === "done") parts.push(el("div", { class: "grammar" }, gr.value));

  return el("div", { class: "detail" }, parts);
}

function renderWordCard(w, region) {
  const saved = savedKeys.has(wordKey(w));
  const dict = w.dictionaryForm && w.dictionaryForm !== w.word ? `Dictionary form: ${w.dictionaryForm}` : null;
  return el(
    "div",
    { class: "word-card" },
    el(
      "div",
      { class: "top" },
      el(
        "div",
        {},
        el("div", { class: "big", lang: "ja" }, w.word),
        el("div", { class: "sub", lang: "ja" }, w.reading),
        el("div", {}, w.meaning),
        el("div", { class: "pos" }, w.partOfSpeech, dict && ` · ${dict}`)
      ),
      el(
        "button",
        { class: saved ? "btn saved" : "btn primary", dataset: { action: saved ? "unsave" : "save" } },
        saved ? "Saved ✓" : "Save word"
      )
    ),
    w.kanji?.length > 0 &&
      el(
        "ul",
        {},
        w.kanji.map((k) =>
          el(
            "li",
            {},
            el("span", { class: "k", lang: "ja" }, k.character),
            el("span", {}, el("span", { class: "sub", lang: "ja" }, k.reading), " · ", k.meaning)
          )
        )
      )
  );
}

// ---------- Rendering: saved words ----------

function renderWords() {
  $("word-count").textContent = words.length;
  $("words-empty").hidden = words.length > 0;
  $("export").disabled = !words.length;
  $("clear").disabled = !words.length;
  $("word-list").replaceChildren(
    ...[...words].reverse().map((w) =>
      el(
        "div",
        { class: "saved-word" },
        el(
          "div",
          { class: "info" },
          el("div", {}, el("span", { class: "ws", lang: "ja" }, w.word), el("span", { class: "wr", lang: "ja" }, w.reading)),
          el("div", {}, w.meaning),
          w.kanji?.length > 0 && el("div", { class: "ctx", lang: "ja" }, kanjiText(w.kanji)),
          w.sentence && el("div", { class: "ctx", lang: "ja" }, `「${w.sentence}」`)
        ),
        el("button", { class: "x", title: "Remove", dataset: { remove: wordKey(w) } }, "×")
      )
    )
  );
}

async function loadWords() {
  words = await getWords();
  savedKeys = new Set(words.map(wordKey));
  renderWords();
}

// ---------- Interaction ----------

function highlightOnPage(index) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "highlight", index }).catch(() => {});
}

function openBubble(i, { scroll = false } = {}) {
  if (!page?.regions[i]) return;
  if (openIndex !== i) selectedWord = -1;
  openIndex = i;
  renderPage();
  loadBreakdown(i);
  highlightOnPage(i);
  if (scroll) document.querySelector(`.bubble[data-index="${i}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

$("bubbles").addEventListener("click", async (e) => {
  const target = e.target.closest("[data-action]");
  const card = e.target.closest(".bubble");
  if (!target || !card) return;
  const i = Number(card.dataset.index);
  const region = page.regions[i];

  switch (target.dataset.action) {
    case "toggle":
      if (openIndex === i) {
        openIndex = -1;
        highlightOnPage(-1);
        renderPage();
      } else {
        openBubble(i);
      }
      break;
    case "word": {
      const wi = Number(target.dataset.word);
      selectedWord = selectedWord === wi ? -1 : wi;
      renderPage();
      break;
    }
    case "save": {
      const w = breakdowns.get(region.japanese).value.words[selectedWord];
      await saveWord({ ...w, sentence: region.japanese, sentenceEnglish: region.english, source: page.url ?? "" });
      break;
    }
    case "unsave": {
      const w = breakdowns.get(region.japanese).value.words[selectedWord];
      await removeWord(wordKey(w));
      break;
    }
    case "retry-breakdown":
      breakdowns.delete(region.japanese);
      loadBreakdown(i);
      break;
    case "grammar":
      grammars.delete(region.japanese);
      loadGrammar(i);
      break;
  }
});

$("word-list").addEventListener("click", (e) => {
  const key = e.target.closest("[data-remove]")?.dataset.remove;
  if (key) removeWord(key);
});

$("export").addEventListener("click", () => {
  const blob = new Blob([wordsToCsv(words)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `yomu-words-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

$("clear").addEventListener("click", () => {
  $("clear").hidden = true;
  $("clear-confirm").hidden = false;
});
$("clear-no").addEventListener("click", () => {
  $("clear").hidden = false;
  $("clear-confirm").hidden = true;
});
$("clear-yes").addEventListener("click", async () => {
  await clearWords();
  $("clear").hidden = false;
  $("clear-confirm").hidden = true;
});

function showTab(name) {
  $("tab-page").setAttribute("aria-selected", name === "page");
  $("tab-words").setAttribute("aria-selected", name === "words");
  $("view-page").hidden = name !== "page";
  $("view-words").hidden = name !== "words";
}
$("tab-page").addEventListener("click", () => showTab("page"));
$("tab-words").addEventListener("click", () => showTab("words"));

// Ctrl+click on the page stores a "focus" request; jump to that bubble.
async function handleFocus(focus) {
  if (!focus || Date.now() - focus.at > 10_000) return;
  if (focus.tabId !== tabId) await loadPage();
  if (focus.tabId !== tabId) return;
  showTab("page");
  openBubble(focus.index, { scroll: true });
}

// ---------- Live updates ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session") {
    if (changes[`tab:${tabId}`]) {
      const next = changes[`tab:${tabId}`].newValue ?? null;
      if (next?.id !== page?.id) {
        openIndex = -1;
        selectedWord = -1;
      }
      page = next;
      renderPage();
    }
    if (changes.focus?.newValue) handleFocus(changes.focus.newValue);
  }
  if (area === "local" && changes.words) {
    loadWords().then(renderPage);
  }
});

chrome.tabs.onActivated.addListener(loadPage);
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) loadPage();
});

// ---------- Start ----------

await loadWords();
await loadPage();
handleFocus((await chrome.storage.session.get("focus")).focus);
