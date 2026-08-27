/**
 * The caption: style, instruments, voice, room.
 *
 * Upstream is blunt that the caption is the most important input to ACE — it
 * matters more than the lyrics for how the result sounds. Its rules, which this
 * file follows:
 *
 *   - Specific beats vague. "sad piano ballad with a breathy female vocal" is a
 *     usable instruction; "a sad song" is not.
 *   - Combine dimensions: genre, emotion, instruments, timbre, vocal character,
 *     production style, tempo feel.
 *   - Do NOT put bpm, key or time signature in the caption. They have dedicated
 *     parameters, and duplicating them here makes results worse.
 *   - Avoid conflicting words. The model resolves contradictions badly, so a
 *     caption should describe one coherent record.
 *
 * Presets rather than free composition, because five well-tested captions beat a
 * generator that can emit a contradiction. The operator edits the result anyway;
 * the job here is to make the starting point good.
 */

import type { Answers, StyleChoice } from "../types.ts";

type Preset = {
  caption: string;
  bpm: number;
  keyScale: string;
  timeSignature: string;
};

/**
 * Every preset is deliberately drumless or brush-only and slow. A memorial song
 * with a backbeat is a different product.
 */
const PRESETS: Record<StyleChoice, Preset> = {
  acoustic: {
    caption:
      "gentle acoustic ballad, fingerpicked steel-string guitar, soft warm vocal, " +
      "sparse upright bass, close-miked and intimate, unhurried, tender, no drums, " +
      "warm analogue recording",
    bpm: 68,
    keyScale: "G Major",
    timeSignature: "4/4",
  },
  piano: {
    caption:
      "solo piano ballad, felt piano, soft sustain, breathy intimate vocal, " +
      "wide warm room, slow and reflective, restrained, no drums",
    bpm: 62,
    keyScale: "C Major",
    timeSignature: "4/4",
  },
  folk: {
    caption:
      "soft folk ballad, nylon-string guitar, quiet fiddle, brushed snare, " +
      "gentle vocal with hushed harmonies, pastoral, warm tape saturation, unhurried",
    bpm: 74,
    keyScale: "D Major",
    timeSignature: "4/4",
  },
  country: {
    caption:
      "quiet country ballad, pedal steel, acoustic guitar, brushed drums, " +
      "warm honest vocal, spacious, unhurried, sincere, no twang",
    bpm: 72,
    keyScale: "G Major",
    timeSignature: "4/4",
  },
  /**
   * The Create flow promises "if you're not sure, we'll choose something
   * gentle". This is that promise, kept: the acoustic preset, softened.
   */
  unsure: {
    caption:
      "gentle acoustic ballad, fingerpicked nylon-string guitar, soft warm vocal, " +
      "sparse felt piano, close-miked and intimate, slow, tender, no drums, " +
      "warm analogue recording",
    bpm: 66,
    keyScale: "C Major",
    timeSignature: "4/4",
  },
};

/**
 * A light tint from how the owner described them.
 *
 * Kept small on purpose. Someone whose dog was "goofy, always stealing socks"
 * should not get the same record as someone whose cat was "quiet, dignified" —
 * but the personality field is a few words, and reading much more than a mood
 * out of it would be inventing things. One clause, appended, never contradicting
 * the preset.
 */
const TINTS: Array<{ match: RegExp; clause: string }> = [
  {
    match: /\b(goofy|silly|clown|daft|clumsy|comic|funny|mischie|cheeky|naughty|troublemaker)\b/i,
    clause: "with a lightly playful lilt",
  },
  {
    match: /\b(gentle|calm|quiet|shy|timid|soft|serene|placid)\b/i,
    clause: "especially hushed and still",
  },
  {
    match: /\b(loyal|devoted|protective|faithful|guard|steadfast)\b/i,
    clause: "steady and resolute in the chorus",
  },
  {
    match: /\b(energetic|bouncy|hyper|wild|boisterous|mad|zoomies|playful)\b/i,
    clause: "with a brighter, more buoyant middle section",
  },
  {
    match: /\b(regal|dignified|proud|elegant|graceful|noble)\b/i,
    clause: "stately and unhurried",
  },
  {
    match: /\b(old|elderly|senior|grey|greying|ancient)\b/i,
    clause: "weathered and warm",
  },
];

export type CaptionResult = {
  caption: string;
  bpm: number;
  keyScale: string;
  timeSignature: string;
  /** What we did and why, surfaced in /studio so the operator can judge it. */
  notes: string[];
};

export function buildCaption(answers: Answers): CaptionResult {
  const style: StyleChoice = answers.style && answers.style in PRESETS ? answers.style : "unsure";
  const preset = PRESETS[style];
  const notes: string[] = [
    style === "unsure"
      ? "No style chosen, so the gentle default was used — as the form promises."
      : `Style preset: ${style}.`,
  ];

  const parts = [preset.caption];

  const descriptive = `${answers.personality ?? ""} ${answers.about ?? ""}`;
  const tint = TINTS.find((t) => t.match.test(descriptive));
  if (tint) {
    parts.push(tint.clause);
    notes.push(`Tinted "${tint.clause}" from how they were described.`);
  }

  // A cat's song and a dog's song are not the same record. Only a nudge, and
  // only where it won't fight the preset.
  if (answers.species === "cat") {
    parts.push("delicate and small-scale");
    notes.push("Scaled down for a cat.");
  }

  return {
    caption: parts.join(", "),
    bpm: preset.bpm,
    keyScale: preset.keyScale,
    timeSignature: preset.timeSignature,
    notes,
  };
}
