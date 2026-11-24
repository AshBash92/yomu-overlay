// Study panel: lists the bubbles from the last translation of the current
// tab, loads word/kanji breakdowns and grammar notes on demand, and
// manages the saved word list.

import { getSettings } from "./settings.js";
import { breakdownLine, explainGrammar, ApiError } from "./claude.js";
import { getWords, saveWord, removeWord, clearWords, wordKey, wordsToCsv, kanjiText, sourceUrl } from "./wordlist.js";
import { getKnown, isKnown, markKnown, unmarkKnown, knownKey, kanjiInKnownWords, parseWordList } from "./known.js";
import { levelOf, kanjiUpTo } from "./jlpt.js";

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
let known = {}; // knownKey -> entry
let level = "N4";
let knownKanji = new Set(); // level list + kanji in known words
let displayMode = "study";
let study = {}; // bubble index -> { english, rating, looked }
let reviewOnly = false;

const RATINGS = [
  ["got", "Got it"],
  ["partly", "Partly"],
  ["missed", "Missed it"],
];
const isStudy = () => displayMode === "study";
const bubbleState = (i) => study[i] ?? { english: false, rating: null, looked: [] };

// Reveals and ratings go through the background worker, which keeps the
// overlay on the page in step.
function sendStudy(i, patch) {
  if (tabId == null || !page) return;
  chrome.runtime.sendMessage({ type: "study-update", tabId, pageId: page.id, indices: [i], ...patch }).catch(() => {});
}

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
  const studyKey = `study:${tabId}`;
  const stored = tabId == null ? {} : await chrome.storage.session.get([key, studyKey]);
  const next = stored[key] ?? null;
  if (next?.id !== page?.id) {
    openIndex = -1;
    selectedWord = -1;
    reviewOnly = false;
  }
  page = next;
  study = stored[studyKey]?.pageId === next?.id ? stored[studyKey]?.bubbles ?? {} : {};
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
  // Answers depend on the learner's level, so cache per level.
  const storeKey = `${prefix}:${level}:${k}`;
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
    const rated = regions.filter((_, i) => bubbleState(i).rating).length;
    const count = isStudy()
      ? `${rated} of ${regions.length} read`
      : `${regions.length} bubble${regions.length === 1 ? "" : "s"}`;
    $("page-meta").textContent = `${count} · translated ${time}`;
  }
  renderRecap(regions);
  const focus = focusedControl();
  const shown = regions
    .map((region, i) => ({ region, i }))
    .filter(({ i }) => !reviewOnly || bubbleState(i).rating !== "got");
  $("bubbles").replaceChildren(...shown.map(({ region, i }) => renderBubble(region, i)));
  restoreFocus(focus);
}

// Sums up the page once every bubble has a rating.
function renderRecap(regions) {
  const box = $("recap");
  const states = regions.map((_, i) => bubbleState(i));
  const done = isStudy() && regions.length > 0 && states.every((s) => s.rating);
  box.hidden = !done;
  if (!done) {
    reviewOnly = false;
    return;
  }
  const got = states.filter((s) => s.rating === "got").length;
  const review = regions.length - got;
  if (!review) reviewOnly = false;
  const sentences = new Set(regions.map((r) => r.japanese));
  const saved = words.filter((w) => sentences.has(w.sentence)).length;
  box.replaceChildren(
    ...[
      el("strong", {}, "Page done"),
      el("span", {}, `${got} of ${regions.length} understood`),
      review > 0 && el("span", {}, `${review} to review`),
      saved > 0 && el("span", {}, `${saved} word${saved === 1 ? "" : "s"} in Learning`),
      review > 0 && el("button", { id: "review-toggle", class: "btn" }, reviewOnly ? "Show all" : "Review these"),
    ].filter(Boolean)
  );
}

// The list is rebuilt on every update, so put keyboard focus back on the
// same control afterwards.
function focusedControl() {
  const active = document.activeElement;
  const bubble = active?.closest?.("#bubbles .bubble");
  if (!bubble) return null;
  const { focusKey, action, word } = active.dataset;
  return { index: bubble.dataset.index, key: focusKey ?? action, word };
}

function restoreFocus(focus) {
  if (!focus) return;
  const bubble = document.querySelector(`.bubble[data-index="${focus.index}"]`);
  if (!bubble) return;
  const controls = [...bubble.querySelectorAll("[data-action]")];
  const match = controls.find(
    (c) => (c.dataset.focusKey ?? c.dataset.action) === focus.key && c.dataset.word === focus.word
  );
  (match ?? bubble.querySelector("header")).focus({ preventScroll: true });
}

function renderBubble(region, i) {
  const open = i === openIndex;
  const st = bubbleState(i);
  // In read-first mode the English stays hidden until you ask for it.
  const showEnglish = !isStudy() || st.english;
  const ratingLabel = RATINGS.find(([r]) => r === st.rating)?.[1];
  return el(
    "article",
    { class: open ? "bubble open" : "bubble", dataset: { index: i } },
    el(
      "header",
      { dataset: { action: "toggle" }, role: "button", tabindex: 0, "aria-expanded": String(open) },
      el("span", { class: "num" }, i + 1),
      el(
        "div",
        { class: "line" },
        el("p", { class: "ja", lang: "ja" }, region.japanese),
        showEnglish && el("p", { class: "en" }, region.english)
      ),
      isStudy() && ratingLabel && el("span", { class: `badge ${st.rating}` }, ratingLabel)
    ),
    open && renderDetail(region, i)
  );
}

function renderDetail(region, i) {
  const bd = breakdowns.get(region.japanese);
  const gr = grammars.get(region.japanese);
  const st = bubbleState(i);
  const parts = [];

  if (bd?.status === "loading" || (!bd && !isStudy())) {
    parts.push(el("p", { class: "loading" }, "Breaking down this line…"));
  } else if (!bd) {
    // Read-first: nothing is looked up until you ask.
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
            {
              class: ["chip", wi === selectedWord && "selected", isKnown(known, w) && "known"].filter(Boolean).join(" "),
              dataset: { action: "word", word: wi },
              title: w.meaning,
            },
            el("span", { class: "r", lang: "ja" }, w.word === w.reading ? " " : w.reading),
            el("span", { class: "w", lang: "ja" }, w.word)
          )
        )
      )
    );
    if (words[selectedWord]) parts.push(renderWordCard(words[selectedWord], region));
  }

  const actions = el("div", { class: "actions" });
  if (isStudy() && !st.english) {
    actions.append(el("button", { class: "btn primary", dataset: { action: "reveal" } }, "Show English"));
  }
  if (isStudy() && !bd) {
    actions.append(el("button", { class: "btn", dataset: { action: "word-help" } }, "Word help"));
  }
  if (bd?.status === "done" && bd.value.words.some((w) => !isKnown(known, w))) {
    actions.append(el("button", { class: "btn", dataset: { action: "know-all" } }, "I knew every word"));
  }
  if (!gr || gr.status === "error") {
    actions.append(el("button", { class: "btn", dataset: { action: "grammar" } }, "Explain grammar"));
  }
  parts.push(actions);
  if (gr?.status === "loading") parts.push(el("p", { class: "loading" }, "Explaining the grammar…"));
  if (gr?.status === "error") parts.push(el("p", { class: "error" }, gr.error));
  if (gr?.status === "done") parts.push(el("div", { class: "grammar" }, gr.value));
  if (isStudy() && st.english) {
    parts.push(
      el(
        "div",
        { class: "rating", role: "group", "aria-label": "Did you get it?" },
        el("span", { class: "label" }, "Did you get it?"),
        RATINGS.map(([rating, label]) =>
          el(
            "button",
            {
              class: "btn",
              "aria-pressed": String(st.rating === rating),
              dataset: { action: "rate", rating, focusKey: `rate-${rating}` },
            },
            label
          )
        )
      )
    );
  }

  return el("div", { class: "detail" }, parts);
}

function renderWordCard(w, region) {
  const saved = savedKeys.has(wordKey(w));
  const knownNow = isKnown(known, w);
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
        "div",
        { class: "buttons" },
        el(
          "button",
          { class: saved ? "btn saved" : "btn primary", dataset: { action: saved ? "unsave" : "save", focusKey: "save" } },
          saved ? "Saved ✓" : "Save word"
        ),
        el(
          "button",
          { class: knownNow ? "btn saved" : "btn", dataset: { action: knownNow ? "unknow" : "know", focusKey: "know" } },
          knownNow ? "Known ✓" : "I know this"
        )
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
            el("span", { style: "flex: 1" }, el("span", { class: "sub", lang: "ja" }, k.reading), " · ", k.meaning),
            kanjiTag(k.character)
          )
        )
      )
  );
}

// "N5 ✓" for kanji you should know at your level, "N3+" for harder ones.
function kanjiTag(ch) {
  const lvl = levelOf(ch);
  const ok = knownKanji.has(ch);
  const label = lvl ? `${lvl}${ok ? " ✓" : ""}` : ok ? "known ✓" : "N3+";
  return el("span", { class: ok ? "tag ok" : "tag", title: ok ? "You know this kanji" : "Above your level" }, label);
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
        el("button", { class: "x", title: "Remove", "aria-label": `Remove ${w.word}`, dataset: { remove: wordKey(w) } }, "×")
      )
    )
  );
}

async function loadWords() {
  words = await getWords();
  savedKeys = new Set(words.map(wordKey));
  renderWords();
}

// ---------- Rendering: known words ----------

function renderKnown() {
  const entries = Object.values(known).sort((a, b) => (b.added ?? "").localeCompare(a.added ?? ""));
  $("known-count").textContent = entries.length;
  $("known-empty").hidden = entries.length > 0;
  const fromList = kanjiUpTo(level).size;
  $("kanji-summary").textContent =
    `Your level: ${level} · ${knownKanji.size} kanji counted as known ` +
    `(${fromList} from the N5${level === "N5" ? "" : "–N4"} list, plus kanji in your known words).`;
  $("known-list").replaceChildren(
    ...entries.map((k) =>
      el(
        "div",
        { class: "known-row" },
        el("span", { class: "ws", lang: "ja" }, k.word),
        el("span", { class: "info" }, [k.reading, k.meaning].filter(Boolean).join(" · ")),
        el("button", { class: "x", title: "Not known after all", "aria-label": `Remove ${k.word} from known words`, dataset: { unknow: k.word } }, "×")
      )
    )
  );
}

async function loadKnown() {
  const settings = await getSettings();
  level = settings.level;
  displayMode = settings.displayMode;
  known = await getKnown();
  knownKanji = new Set([...kanjiUpTo(level), ...kanjiInKnownWords(known)]);
  renderKnown();
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
  if (!isStudy()) loadBreakdown(i);
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
      if (isStudy() && selectedWord === wi) {
        sendStudy(i, { look: breakdowns.get(region.japanese).value.words[wi].word });
      }
      renderPage();
      break;
    }
    case "reveal":
      sendStudy(i, { english: true });
      break;
    case "word-help":
      loadBreakdown(i);
      break;
    case "rate":
      sendStudy(i, { rating: target.dataset.rating });
      break;
    case "save": {
      const w = breakdowns.get(region.japanese).value.words[selectedWord];
      await saveWord({ ...w, sentence: region.japanese, sentenceEnglish: region.english, source: sourceUrl(page.url) });
      break;
    }
    case "unsave": {
      const w = breakdowns.get(region.japanese).value.words[selectedWord];
      await removeWord(wordKey(w));
      break;
    }
    case "know":
      await markKnown([breakdowns.get(region.japanese).value.words[selectedWord]]);
      break;
    case "unknow":
      await unmarkKnown(knownKey(breakdowns.get(region.japanese).value.words[selectedWord]));
      break;
    case "know-all":
      await markKnown(breakdowns.get(region.japanese).value.words);
      break;
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

// Bubble headers act as buttons, so Enter and Space open them too.
$("bubbles").addEventListener("keydown", (e) => {
  if ((e.key !== "Enter" && e.key !== " ") || !e.target.matches("header[data-action]")) return;
  e.preventDefault();
  e.target.click();
});

$("recap").addEventListener("click", (e) => {
  if (e.target.id !== "review-toggle") return;
  reviewOnly = !reviewOnly;
  renderPage();
  $("review-toggle")?.focus();
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

$("known-list").addEventListener("click", (e) => {
  const key = e.target.closest("[data-unknow]")?.dataset.unknow;
  if (key) unmarkKnown(key);
});

async function importWords(text) {
  const found = parseWordList(text);
  const before = Object.keys(known).length;
  await markKnown(found.map((word) => ({ word })), "import");
  const added = Object.keys(await getKnown()).length - before;
  $("import-result").textContent = found.length
    ? `Added ${added} new word${added === 1 ? "" : "s"} (${found.length - added} already known).`
    : "No Japanese words found.";
}

$("import-paste").addEventListener("click", async () => {
  await importWords($("import-text").value);
  $("import-text").value = "";
});
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await importWords(await file.text());
  e.target.value = "";
});

const TABS = ["page", "words", "known"];
function showTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", name === t);
    $(`view-${t}`).hidden = name !== t;
  }
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => showTab(t));

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
        reviewOnly = false;
      }
      page = next;
      renderPage();
    }
    if (changes[`study:${tabId}`]) {
      const next = changes[`study:${tabId}`].newValue;
      study = next?.pageId === page?.id ? next?.bubbles ?? {} : {};
      renderPage();
    }
    if (changes.focus?.newValue) handleFocus(changes.focus.newValue);
  }
  if (area === "local" && changes.words) {
    loadWords().then(renderPage);
  }
  if (area === "local" && (changes.known || changes.level || changes.displayMode)) {
    if (changes.level) {
      // Cached answers were pitched at the old level.
      breakdowns.clear();
      grammars.clear();
    }
    loadKnown().then(() => {
      renderPage();
      if (changes.level && openIndex >= 0 && !isStudy()) loadBreakdown(openIndex);
    });
  }
});

chrome.tabs.onActivated.addListener(loadPage);
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) loadPage();
});

// ---------- Start ----------

await loadWords();
await loadKnown();
await loadPage();
handleFocus((await chrome.storage.session.get("focus")).focus);
