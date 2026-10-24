// Approximate JLPT kanji lists, based on common study lists (the JLPT
// hasn't published official lists since 2010). Only N5 and N4 are
// included so far; higher levels count these as known.

const KANJI = {
  N5:
    "一二三四五六七八九十百千万円日月火水木金土曜年時分半今何午前後先生毎週" +
    "人男女子父母友名学校本語書読聞見話言行来出入休食飲買会大小中長高安新古" +
    "多少白上下左右外東西南北国山川田天気雨電車駅道店社間手耳目口足花魚立",
  N4:
    "同事自発者地業方場員開力問代明動京通理体主題意不作用度強公持野以思家世" +
    "正院心界教文元重近考画海売知集別物使品計死特私始朝運終台広住真町料工建" +
    "空急止送切転研究楽起着病質待試族銀早映親験英医仕去味写字答夜音注帰歌悪" +
    "図室歩風紙黒春赤青館屋色走秋夏習洋旅服夕借肉貸堂鳥飯勉冬昼茶弟牛兄犬妹" +
    "姉漢光",
};

export const LEVELS = ["N5", "N4", "N3", "N2", "N1"];

const sets = Object.fromEntries(Object.entries(KANJI).map(([lvl, s]) => [lvl, new Set(s)]));

/** "N5", "N4", or null if the kanji isn't in the bundled lists. */
export function levelOf(ch) {
  if (sets.N5.has(ch)) return "N5";
  if (sets.N4.has(ch)) return "N4";
  return null;
}

/** Kanji a learner at this level should already know. */
export function kanjiUpTo(level) {
  const out = new Set(sets.N5);
  if (level !== "N5") for (const k of sets.N4) out.add(k);
  return out;
}

export const isKanji = (ch) => /[㐀-鿿]/.test(ch);
