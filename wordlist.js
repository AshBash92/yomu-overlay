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

// Anki (2.1.55+) reads the # header lines to pick the separator and
// name the columns, so the import dialog needs no setup.
export function wordsToCsv(words) {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
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
        w.source,
        w.added?.slice(0, 10),
      ]
        .map(cell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}
