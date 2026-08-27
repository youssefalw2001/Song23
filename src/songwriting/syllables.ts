/**
 * Counting syllables, approximately.
 *
 * ACE aligns lyrics to beats, so line length is a musical decision, not a
 * stylistic one. Upstream's guidance is 6–10 syllables per line, with lines in
 * the same position kept within one or two of each other. A ten-syllable line
 * where the model expects seven is where you get the rushed, crammed delivery
 * that makes generated vocals sound generated.
 *
 * This is a heuristic, not a dictionary. It is wrong on names and on borrowed
 * words, and it does not need to be right — it needs to reject the line that
 * cannot be sung in one breath. Being off by one on "Ellie" costs nothing.
 */

const VOWELS = "aeiouy";

/** Endings where a trailing 'e' is silent: "home" is one syllable, not two. */
function hasSilentE(word: string): boolean {
  if (!word.endsWith("e") || word.length < 3) return false;
  // "le" after a consonant is its own syllable: "basket"/"candle"/"little".
  if (word.endsWith("le") && !VOWELS.includes(word[word.length - 3] ?? "")) return false;
  // "ee", "ie", "oe" are not silent: "knee", "pie".
  if (VOWELS.includes(word[word.length - 2] ?? "")) return false;
  return true;
}

export function countSyllablesInWord(raw: string): number {
  const word = raw.toLowerCase().replace(/[^a-z']/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;

  let count = 0;
  let previousWasVowel = false;
  for (const ch of word) {
    const isVowel = VOWELS.includes(ch);
    if (isVowel && !previousWasVowel) count += 1;
    previousWasVowel = isVowel;
  }

  if (hasSilentE(word)) count -= 1;

  // "-ed" is usually not its own syllable unless preceded by t or d:
  // "walked" is one, "wanted" is two.
  if (word.endsWith("ed") && word.length > 4) {
    const before = word[word.length - 3] ?? "";
    if (before !== "t" && before !== "d") count -= 1;
  }

  return Math.max(1, count);
}

export function countSyllables(line: string): number {
  return line
    .split(/[\s—–-]+/)
    .filter(Boolean)
    .reduce((total, word) => total + countSyllablesInWord(word), 0);
}

/** The window upstream recommends for a sung line. */
export const SINGABLE_MIN = 4;
export const SINGABLE_IDEAL_MIN = 6;
export const SINGABLE_IDEAL_MAX = 10;
export const SINGABLE_MAX = 13;

export function isSingable(line: string): boolean {
  const n = countSyllables(line);
  return n >= SINGABLE_MIN && n <= SINGABLE_MAX;
}

export function isIdeal(line: string): boolean {
  const n = countSyllables(line);
  return n >= SINGABLE_IDEAL_MIN && n <= SINGABLE_IDEAL_MAX;
}
