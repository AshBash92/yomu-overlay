// Words you already know, kept in chrome.storage.local.
// Keyed by dictionary form so every conjugation of a verb counts.

import { isKanji } from "./jlpt.js";

const KEY = "known";

export const knownKey = (w) => w.dictionaryForm || w.word;

export async function getKnown() {
  return (await chrome.storage.local.get(KEY))[KEY] ?? {};
}

export function isKnown(known, w) {
  return Boolean(known[knownKey(w)] || known[w.word]);
}

export async function markKnown(words, source = "panel") {
  const known = await getKnown();
  const added = new Date().toISOString();
  for (const w of words) {
    const key = knownKey(w);
    if (!key || known[key]) continue;
    known[key] = { word: key, reading: w.reading ?? "", meaning: w.meaning ?? "", source, added };
  }
  await chrome.storage.local.set({ [KEY]: known });
}

export async function unmarkKnown(key) {
  const known = await getKnown();
  delete known[key];
  await chrome.storage.local.set({ [KEY]: known });
}

/** Every kanji that appears in a known word. */
export function kanjiInKnownWords(known) {
  const out = new Set();
  for (const key of Object.keys(known)) for (const ch of key) if (isKanji(ch)) out.add(ch);
  return out;
}

const JAPANESE = /[぀-ヿ㐀-鿿]/;

/**
 * Pulls words out of pasted text or an Anki export: one word per line,
 * or the first column of a tab/comma separated file. Strips HTML and
 * Anki furigana like 漢字[かんじ].
 */
export function parseWordList(text) {
  const words = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let first = line.split(/\t|,/)[0];
    first = first
      .replace(/^"|"$/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/\s+/g, "");
    if (first && JAPANESE.test(first)) words.add(first);
  }
  return [...words];
}
