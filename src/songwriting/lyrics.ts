/**
 * Assembling the lyric.
 *
 * Read this before you trust the output: **this builds a draft, not a finished
 * song.** It is deliberately conservative about what it invents, because the
 * alternative is worse. Two things forced that decision:
 *
 *   - ACE's own lyric-writing path is unusable for this. Asked to tidy up "he
 *     slept in the laundry basket and never in his bed. thirteen years. we miss
 *     him", it returned "Twenty years. We miss him.Thirty." and a verse reading
 *     "PDm, 12:28, 12:28, 12:28". It invented a number and emitted noise. For a
 *     memorial song someone paid for, that is not a rough edge, it is a refund.
 *   - The generic failure of generated lyrics is vagueness — "neon skies,
 *     electric hearts" — which upstream's own guide lists as red flag number one.
 *
 * So the verses are built almost entirely from the owner's own sentences, picked
 * for length and concreteness by lines.ts and reordered, not rewritten. Their
 * words are the asset. The only thing this file really writes is the chorus hook,
 * because a chorus has to repeat and their prose doesn't, and every hook it
 * produces is flagged for the operator to replace.
 *
 * The output is honest about its own gaps. `warnings` is not decoration — it is
 * the list of things a human has to look at before this song is sent to someone
 * who is grieving.
 */

import type { Answers, SongBrief } from "../types.ts";
import { candidatesFrom, extractNames, extractExclusions, type Candidate } from "./lines.ts";
import { countSyllables } from "./syllables.ts";

/**
 * One core metaphor per song — upstream's rule, and good writing advice besides.
 * Mixing "water, then fire, then flying" leaves a listener with nothing to hold.
 *
 * Each motif is chosen from words the owner actually used, so the metaphor is
 * theirs rather than ours. The default is last and deliberately plain.
 */
type Motif = {
  id: string;
  match: RegExp;
  /** 6–10 syllables each. `NAME` is substituted. */
  hook: string[];
  outro: string;
  why: string;
};

const MOTIFS: Motif[] = [
  {
    id: "door",
    match: /\b(door|waited|waiting|greet|greeted|welcome|home from work|hear(?:d)? the car)\b/i,
    hook: [
      "You're still at the door in my head",
      "Still the first one there",
      "NAME, you're still at the door",
      "Still waiting on the stair",
    ],
    outro: "Still at the door",
    why: "They wrote about waiting or greeting, so the song holds onto the door.",
  },
  {
    id: "spot",
    match: /\b(bed|basket|blanket|chair|sofa|couch|cushion|spot|corner|rug|mat)\b/i,
    hook: [
      "Your spot is still your spot",
      "Nobody sits there now",
      "NAME, it's still your spot",
      "We leave it where it was",
    ],
    outro: "Still your spot",
    why: "They wrote about a place that was theirs, so the empty place carries the chorus.",
  },
  {
    id: "walk",
    match: /\b(walk|walked|walks|lead|leash|park|field|路|route|beach|woods)\b/i,
    hook: [
      "I still take the long way round",
      "Still your side of the road",
      "NAME, I still take the long way",
      "Still walking you home",
    ],
    outro: "Still the long way home",
    why: "They wrote about walks, so the song stays on the route.",
  },
  {
    id: "garden",
    match: /\b(garden|yard|sun|sunlight|sunshine|grass|tree|window|porch)\b/i,
    hook: [
      "The garden still knows your name",
      "The sun still finds your patch",
      "NAME, the garden knows",
      "Still warm where you lay",
    ],
    outro: "The garden knows your name",
    why: "They wrote about outdoors or sunlight, so the song stays there.",
  },
  {
    id: "home",
    match: /.*/,
    hook: [
      "You were always home",
      "Never the house, just you",
      "NAME, you were always home",
      "You were always home to me",
    ],
    outro: "Always home",
    why: "No single image stood out, so the song uses the plainest true one.",
  },
];

export type LyricsResult = {
  lyrics: string;
  /** Things a human must check before this is sent. Not cosmetic. */
  warnings: string[];
  /** What was done, for the operator's benefit. */
  notes: string[];
  /** Lines found in the owner's writing but not used, offered as alternates. */
  unusedLines: Candidate[];
};

type Section = { tag: string; lines: string[] };

function render(sections: Section[]): string {
  return sections
    .map((s) => (s.lines.length ? `${s.tag}\n${s.lines.join("\n")}` : s.tag))
    .join("\n\n");
}

/**
 * How much song the requested duration can actually hold.
 *
 * From upstream's estimates: two verses and two choruses need 120–150s; adding a
 * bridge pushes it to 180–240s. Writing a bridge into a 90-second track just
 * means the model races the words or drops them.
 */
function planStructure(
  durationSeconds: number,
  /**
   * Set when the owner asked for a person to be named. The bridge is where that
   * name goes, so the section stops being optional.
   *
   * This exists because of a bug worth remembering: the brief is built in two
   * passes, and when the recomputed duration came in under 150s the bridge was
   * dropped — silently deleting the daughter's name from a song whose owner had
   * explicitly asked for it. The structure now leads and the duration follows,
   * never the other way round.
   */
  bridgeRequired = false,
): { verses: number; bridge: boolean; instrumental: boolean } {
  if (durationSeconds < 100 && !bridgeRequired) {
    return { verses: 1, bridge: false, instrumental: false };
  }
  if (durationSeconds < 150 && !bridgeRequired) {
    return { verses: 2, bridge: false, instrumental: false };
  }
  if (durationSeconds < 210) return { verses: 2, bridge: true, instrumental: false };
  return { verses: 3, bridge: true, instrumental: true };
}

/** Shortest duration that can hold two verses, two choruses and a bridge. */
export const MIN_DURATION_WITH_BRIDGE = 180;

/** Whether this set of answers requires a bridge to honour a naming request. */
export function requiresBridge(answers: Answers): boolean {
  return extractNames(answers.include).length > 0;
}

export function buildLyrics(answers: Answers, durationSeconds: number): LyricsResult {
  const warnings: string[] = [];
  const notes: string[] = [];

  const name = answers.petName.trim() || "you";

  // Gather singable lines from every field the owner wrote in, best first.
  // `memories` leads because the form asks there for the small specific things,
  // and those are the lines worth singing.
  const pool: Candidate[] = [
    ...candidatesFrom(answers.memories, "memories"),
    ...candidatesFrom(answers.about, "about"),
    ...candidatesFrom(answers.personality, "personality"),
  ].sort((a, b) => b.score - a.score);

  if (pool.length === 0) {
    warnings.push(
      "Nothing in their answers was usable as a sung line. The verses below are " +
        "placeholders — this song cannot be generated until someone writes them.",
    );
  } else {
    notes.push(`Found ${pool.length} singable lines in their own words.`);
  }

  const motif = MOTIFS.find((m) => {
    const haystack = `${answers.memories ?? ""} ${answers.about ?? ""} ${answers.personality ?? ""}`;
    return m.match.test(haystack);
  })!;
  notes.push(`Motif "${motif.id}": ${motif.why}`);

  const chorus = motif.hook.map((line) => line.replace(/NAME/g, name));
  warnings.push(
    `The chorus is the only part written from scratch ("${chorus[0]}"). ` +
      "It is the most-repeated part of the song and the least personal thing here. " +
      "Rewrite it if you can.",
  );

  const plan = planStructure(durationSeconds, requiresBridge(answers));
  const used = new Set<string>();

  /** Take the next n best unused lines. */
  const take = (n: number): string[] => {
    const out: string[] = [];
    for (const candidate of pool) {
      if (out.length >= n) break;
      if (used.has(candidate.text)) continue;
      used.add(candidate.text);
      out.push(candidate.text);
    }
    while (out.length < n) {
      out.push(`[write a line here — ${n - out.length} still needed]`);
    }
    return out;
  };

  const sections: Section[] = [{ tag: "[Intro]", lines: [] }];

  sections.push({ tag: "[Verse 1]", lines: take(4) });
  sections.push({ tag: "[Chorus]", lines: chorus });

  if (plan.verses >= 2) {
    sections.push({ tag: "[Verse 2]", lines: take(4) });
    sections.push({ tag: "[Chorus]", lines: chorus });
  }

  if (plan.bridge) {
    const names = extractNames(answers.include);
    if (names.length > 0) {
      // The single highest-value line in the song. Someone asked for it by name.
      const person = names[0]!;
      sections.push({
        tag: "[Bridge]",
        lines: [`${person} still says your name`, `${name}, you were hers as much as mine`],
      });
      notes.push(`Bridge names ${person}, as requested in "Anything you'd like in the song?".`);
      if (names.length > 1) {
        warnings.push(
          `They mentioned more than one name (${names.join(", ")}) but only ${person} made it ` +
            "into the bridge. Check that's the right one.",
        );
      }
    } else {
      sections.push({ tag: "[Bridge]", lines: take(2) });
    }
    sections.push({ tag: "[Chorus]", lines: chorus });
  }

  if (plan.verses >= 3) {
    sections.push({ tag: "[Verse 3]", lines: take(4) });
  }

  if (plan.instrumental) {
    sections.push({ tag: "[Guitar Solo]", lines: [] });
  }

  sections.push({ tag: "[Outro]", lines: [motif.outro.replace(/NAME/g, name), name] });

  // --- checks worth surfacing rather than silently shipping -----------------

  const exclusions = extractExclusions(answers.include);
  if (exclusions.length > 0) {
    warnings.push(
      `They asked us to leave something out: ${exclusions
        .map((e) => `"${e}"`)
        .join(", ")}. Read every line against that before generating.`,
    );
  }

  const placeholders = sections.flatMap((s) => s.lines).filter((l) => l.startsWith("[write"));
  if (placeholders.length > 0) {
    warnings.push(
      `${placeholders.length} line${placeholders.length === 1 ? "" : "s"} could not be filled ` +
        "from their answers and must be written by hand.",
    );
  }

  // Lines that are the wrong length get crammed or stretched by the model.
  const tooLong = sections
    .flatMap((s) => s.lines)
    .filter((l) => !l.startsWith("[write") && countSyllables(l) > 12);
  if (tooLong.length > 0) {
    warnings.push(
      `${tooLong.length} line${tooLong.length === 1 ? " is" : "s are"} over 12 syllables and ` +
        `will sound rushed. Longest: "${tooLong[0]}".`,
    );
  }

  const unusedLines = pool.filter((c) => !used.has(c.text));

  return { lyrics: render(sections), warnings, notes, unusedLines };
}

/**
 * Duration from the shape of the lyric, not from a guess.
 *
 * Slower tempos need more seconds for the same words, which is why bpm is an
 * input here. Erring long is right: a song that runs out of room crams the last
 * verse, and upstream says the same.
 */
export function suggestDuration(lyrics: string, bpm: number): number {
  const sections = (lyrics.match(/^\[/gm) ?? []).length;
  const sungLines = lyrics
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("["));

  const syllables = sungLines.reduce((total, line) => total + countSyllables(line), 0);

  // Roughly two syllables per beat at a ballad tempo, plus room for the
  // instrumental top and tail of each section.
  const beats = syllables / 2;
  const sungSeconds = (beats / bpm) * 60;
  const sectionOverhead = sections * 6;

  const estimate = Math.round((sungSeconds + sectionOverhead) / 15) * 15;
  return Math.min(240, Math.max(90, estimate));
}

/** Everything the model needs, assembled and self-reporting. */
export type BriefResult = {
  brief: SongBrief;
  warnings: string[];
  notes: string[];
  unusedLines: Candidate[];
};
