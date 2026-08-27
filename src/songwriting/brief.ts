/**
 * Answers in, a reviewable brief out.
 *
 * This is the seam the whole service is built around. Generating audio from a
 * brief is mechanical and fast; deciding what the brief should say is the part
 * that needs judgement. Keeping them separate is what lets the operator read the
 * lyrics, fix the chorus, and only then spend a generation on it.
 */

import type { Answers, SongBrief } from "../types.ts";
import { buildCaption } from "./caption.ts";
import {
  buildLyrics,
  suggestDuration,
  requiresBridge,
  MIN_DURATION_WITH_BRIDGE,
  type BriefResult,
} from "./lyrics.ts";
import { candidatesFrom } from "./lines.ts";

/**
 * A title, taken rather than invented.
 *
 * The best title is nearly always a phrase the owner already wrote. Falling back
 * to "For Buddy" is fine and honest; inventing "Eternal Paws Forever" is not.
 */
export function buildTitle(answers: Answers): string {
  const name = answers.petName.trim() || "them";

  const pool = [
    ...candidatesFrom(answers.memories, "memories"),
    ...candidatesFrom(answers.about, "about"),
  ];

  // A title wants to be shorter than a sung line.
  const short = pool
    .filter((c) => c.syllables >= 4 && c.syllables <= 8)
    .sort((a, b) => b.score - a.score);

  const best = short[0];
  if (best) {
    // Title case, but leave deliberate capitals alone.
    return best.text.replace(/\s+/g, " ").trim();
  }

  return `For ${name}`;
}

export function buildBrief(answers: Answers, overrides?: Partial<SongBrief>): BriefResult {
  if (!answers.petName?.trim()) {
    throw new Error("petName is required — the song is about them");
  }

  const caption = buildCaption(answers);

  // Lyrics are written against a provisional length, then the length is
  // recomputed from the lyrics that came out. Two passes, because the structure
  // depends on the duration and the duration depends on the structure.
  //
  // The floor is the important part. If the owner asked for someone to be named,
  // the song needs a bridge to put them in, and a bridge needs the seconds to
  // exist. Letting the recomputed duration fall below that would quietly drop the
  // one line they explicitly asked for.
  const bridgeNeeded = requiresBridge(answers);
  const floor = bridgeNeeded ? MIN_DURATION_WITH_BRIDGE : 90;

  const provisional = buildLyrics(answers, MIN_DURATION_WITH_BRIDGE);
  const duration = Math.max(floor, suggestDuration(provisional.lyrics, caption.bpm));
  const final =
    duration === MIN_DURATION_WITH_BRIDGE ? provisional : buildLyrics(answers, duration);

  const notes = [...caption.notes, ...final.notes];
  notes.push(`Length ${duration}s, from the shape of the lyric at ${caption.bpm} bpm.`);
  if (bridgeNeeded && duration === floor) {
    notes.push(
      `Held at ${floor}s so the bridge survives — they asked for someone to be named in it.`,
    );
  }

  const brief: SongBrief = {
    title: buildTitle(answers),
    caption: caption.caption,
    lyrics: final.lyrics,
    durationSeconds: duration,
    bpm: caption.bpm,
    keyScale: caption.keyScale,
    timeSignature: caption.timeSignature,
    vocalLanguage: "en",
    ...overrides,
  };

  return {
    brief,
    warnings: final.warnings,
    notes,
    unusedLines: final.unusedLines,
  };
}

/** Reject a brief that would waste a generation. */
export function validateBrief(brief: SongBrief): string[] {
  const problems: string[] = [];

  if (!brief.caption.trim()) problems.push("caption is empty");
  if (!brief.lyrics.trim()) problems.push('lyrics are empty (use "[inst]" for an instrumental)');
  if (brief.durationSeconds < 10 || brief.durationSeconds > 600) {
    problems.push(`durationSeconds ${brief.durationSeconds} is outside the supported 10–600 range`);
  }
  if (brief.bpm !== undefined && (brief.bpm < 30 || brief.bpm > 300)) {
    problems.push(`bpm ${brief.bpm} is outside the supported 30–300 range`);
  }
  if (brief.lyrics.includes("[write a line here")) {
    problems.push(
      "lyrics still contain generated placeholders — write them before generating",
    );
  }

  return problems;
}

export type { BriefResult };
