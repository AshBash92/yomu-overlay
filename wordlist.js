// Personal word list, kept in chrome.storage.local, plus Anki CSV export.

const KEY = "words";

export const wordKey = (w) => `${w.word}|${w.reading}`;

export async function getWords() {
  return (await chrome.storage.local.get(KEY))[KEY] ?? [];
}

export async function saveWord(entry) {
  const words = await getWords();
  if (words.some((w) => wordKey(w) === wordKey(entry))) return;
  words.push({ ...entry, added: new Date().toISOString() });
  await chrome.storage.local.set({ [KEY]: words });
}

export async function removeWord(key) {
  const words = await getWords();
  await chrome.storage.local.set({ [KEY]: words.filter((w) => wordKey(w) !== key) });
}

export async function clearWords() {
  await chrome.storage.local.set({ [KEY]: [] });
}

export function kanjiText(kanji = []) {
  return kanji.map((k) => `${k.character} (${k.reading}): ${k.meaning}`).join("; ");
}

const COLUMNS = [
  "Word",
  "Reading",
  "Dictionary form",
  "Meaning",
  "Part of speech",
  "Kanji",
  "Sentence",
  "Sentence translation",
  "Source",
  "Added",
];

/**
 * The page a word came from, without its query string or fragment, which
 * can hold session tokens or signed links. Empty for non-web pages.
 */
export function sourceUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : "";
  } catch {
    return "";
  }
}

// Spreadsheets run cells starting with these as formulas, and this text
// comes from web pages. A zero-width space stops that without showing up
// on Anki cards (an apostrophe would, on meanings like "-san").
const FORMULA_START = /^\s*[=+\-@＝＋－＠]/;
const defuseFormula = (s) => (FORMULA_START.test(s) ? `​${s}` : s);

// Anki (2.1.55+) reads the # header lines to pick the separator and
// name the columns, so the import dialog needs no setup.
export function wordsToCsv(words) {
  const cell = (v) => `"${defuseFormula(String(v ?? "")).replace(/"/g, '""')}"`;
  const lines = ["#separator:comma", "#html:false", `#columns:${COLUMNS.join(",")}`];
  for (const w of words) {
    lines.push(
      [
        w.word,
        w.reading,
        w.dictionaryForm,
        w.meaning,
        w.partOfSpeech,
        kanjiText(w.kanji),
        w.sentence,
        w.sentenceEnglish,
        sourceUrl(w.source),
        w.added?.slice(0, 10),
      ]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}
