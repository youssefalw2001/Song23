/**
 * Turning what someone wrote into lines that can be sung.
 *
 * The premise of this whole file: the customer's own words are better than
 * anything we could generate. "He never once slept in the bed we bought" is a
 * lyric already — it is specific, it is theirs, and no model would have invented
 * it. The failure mode of AI lyrics is the opposite: "neon skies, electric
 * hearts, endless dreams", which upstream's own guide calls out as the first red
 * flag of AI-flavoured writing.
 *
 * So this does not write. It finds the sentences someone already wrote that
 * happen to be the right length to sing, cleans them minimally, and ranks them
 * by how concrete they are. What comes out is a shortlist for the operator, not
 * a finished lyric.
 */

import { countSyllables, isSingable, isIdeal } from "./syllables.ts";

export type Candidate = {
  text: string;
  syllables: number;
  /** Higher is better. Concrete and specific beats abstract and general. */
  score: number;
  /** Which answer field it came from, so the operator can see the provenance. */
  source: string;
};

/**
 * Words that signal a concrete, physical, specific detail — the things that
 * actually end up in a good memorial lyric. Presence of these is the strongest
 * cheap signal that a line is worth keeping.
 */
const CONCRETE_HINTS = [
  // places a pet occupies
  "bed", "basket", "sofa", "couch", "chair", "floor", "rug", "mat", "blanket",
  "door", "window", "step", "stairs", "garden", "yard", "kitchen", "porch",
  "car", "seat", "lap", "sun", "sunlight", "fire", "corner", "hall", "room",
  // things they interact with
  "lead", "leash", "collar", "bowl", "ball", "toy", "rope", "stick", "bone",
  "brush", "towel", "laundry", "washing", "coat", "boots", "shoes", "keys",
  // actions
  "slept", "sleep", "sat", "walked", "walk", "ran", "chased", "barked", "purred",
  "waited", "wagged", "curled", "stretched", "followed", "greeted", "carried",
  "dug", "swam", "jumped", "licked", "nudged", "stole", "hid", "howled",
  // time and weather anchor a memory
  "morning", "evening", "night", "winter", "summer", "rain", "snow", "autumn",
  "sunday", "christmas", "birthday", "years", "year",
];

const ABSTRACT_PENALTY = [
  "love", "loved", "heart", "soul", "forever", "always", "memory", "memories",
  "special", "amazing", "wonderful", "beautiful", "perfect", "best", "miss",
];

/** Fragments that are meta-commentary about the form, not content for it. */
const NOISE = [
  /^(um+|uh+|erm+)\b/i,
  /^(i don'?t know|not sure|no idea)\b/i,
  /^(etc|and so on)\b/i,
  /^(please|could you|can you|i'?d like)\b/i,
];

function splitIntoClauses(prose: string): string[] {
  const out: string[] = [];

  // Sentences first.
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    out.push(trimmed);

    // Long sentences usually contain two singable clauses. Split on the joints
    // people actually write with, and keep both halves as candidates.
    //
    // The threshold is 10 rather than the 13-syllable singable ceiling on
    // purpose: "Always the laundry basket, right on the warm clothes" is 13 and
    // technically singable, but splitting it also yields "Always the laundry
    // basket" at 7, which sits in the ideal window and is the better line. Offer
    // both and let scoring decide.
    if (countSyllables(trimmed) > 10) {
      for (const clause of trimmed.split(/\s*[,;:]\s*|\s+(?:and|but|so|then|because)\s+/i)) {
        const c = clause.trim();
        if (c && c !== trimmed) out.push(c);
      }
    }
  }

  return out;
}

function clean(raw: string): string {
  let text = raw
    .trim()
    .replace(/\s+/g, " ")
    // Terminal punctuation is meaningless in a sung line.
    .replace(/[.,;:!?]+$/, "")
    // Leading conjunctions read as fragments on the page but sing fine; still,
    // dropping them makes the line stand on its own in the operator's list.
    .replace(/^(?:and|but|so|then|because|also)\s+/i, "")
    .trim();

  if (!text) return "";

  // Sentence case, but never lowercase something that was deliberately caps
  // (upstream treats UPPERCASE as an intensity marker).
  if (text === text.toUpperCase() && text.length > 4) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function scoreLine(text: string): number {
  const lower = ` ${text.toLowerCase()} `;
  let score = 0;

  for (const hint of CONCRETE_HINTS) {
    if (lower.includes(` ${hint} `) || lower.includes(` ${hint},`)) score += 3;
  }
  for (const word of ABSTRACT_PENALTY) {
    if (lower.includes(` ${word} `)) score -= 2;
  }

  // Numbers are gold: "thirteen years", "eight weeks old".
  if (/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.test(text)) {
    score += 4;
  }

  // Negation often marks the memorable, particular habit: "never once slept in
  // the bed we bought". These are the lines worth singing.
  if (/\b(never|didn'?t|wouldn'?t|couldn'?t|no other)\b/i.test(text)) score += 3;

  // Right in the pocket for the beat.
  if (isIdeal(text)) score += 2;

  // Very short lines are usually fragments left over from a split.
  const syllables = countSyllables(text);
  if (syllables < 5) score -= 2;

  // Over eleven and the model starts cramming. Still allowed — a great long line
  // beats a bland short one — but it has to earn its place against the shorter
  // clause it was split into.
  if (syllables > 11) score -= 3;

  return score;
}

/** Pull singable candidate lines out of one answer field. */
export function candidatesFrom(prose: string | undefined, source: string): Candidate[] {
  if (!prose?.trim()) return [];

  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const clause of splitIntoClauses(prose)) {
    const text = clean(clause);
    if (!text) continue;
    if (NOISE.some((re) => re.test(text))) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (!isSingable(text)) continue;

    candidates.push({
      text,
      syllables: countSyllables(text),
      score: scoreLine(text),
      source,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Names to keep in the song.
 *
 * The `include` field is where someone writes "please include my daughter Ellie
 * — he was really her dog". Getting that name into the bridge is the single
 * highest-value thing the song can do, and the single worst thing to get wrong.
 */
export function extractNames(include: string | undefined): string[] {
  if (!include?.trim()) return [];

  const stopwords = new Set([
    "I", "My", "We", "Our", "He", "She", "They", "It", "The", "A", "An",
    "And", "But", "Please", "Also", "Include", "Mention", "Don't", "Do",
    "His", "Her", "Their", "Him", "Them", "This", "That",
  ]);

  const found = new Set<string>();
  for (const match of include.matchAll(/\b([A-Z][a-z]{1,15})\b/g)) {
    const name = match[1]!;
    if (stopwords.has(name)) continue;
    found.add(name);
  }
  return [...found];
}

/**
 * Things the customer asked us to leave out.
 *
 * "please don't mention the illness" has to be honoured, and honoured visibly.
 * This returns the phrases so the studio page can show them next to the lyrics
 * as a standing warning rather than burying them in the original answers.
 */
export function extractExclusions(include: string | undefined): string[] {
  if (!include?.trim()) return [];

  const out: string[] = [];
  const pattern =
    /\b(?:don'?t|do not|please don'?t|rather not|no|avoid|leave out|not)\s+(?:mention|include|say|talk about|reference|bring up)?\s*([^.,;!?\n]{3,80})/gi;

  for (const match of include.matchAll(pattern)) {
    const phrase = match[1]?.trim();
    if (phrase) out.push(phrase);
  }
  return out;
}
