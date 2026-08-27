/**
 * Assertions over the songwriting layer. No test framework, no network.
 *
 *   node --experimental-strip-types src/scripts/check.ts
 *
 * These are regression tests, not coverage. Each one is here because something
 * went wrong or could plausibly go wrong in a way that would reach a customer
 * silently — which is the failure mode that matters. A song that is merely
 * mediocre gets caught by the operator reading it. A song that quietly dropped
 * the name of the daughter whose dog it was does not.
 */

import { buildBrief, validateBrief } from "../songwriting/brief.ts";
import { buildLyrics, requiresBridge, suggestDuration } from "../songwriting/lyrics.ts";
import { candidatesFrom, extractNames, extractExclusions } from "../songwriting/lines.ts";
import { countSyllables } from "../songwriting/syllables.ts";
import { probeAudio, looksLikeAudio } from "../audio.ts";
import type { Answers } from "../types.ts";

let failures = 0;
let checks = 0;

function ok(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function group(name: string): void {
  console.log(`\n${name}`);
}

const BUDDY: Answers = {
  petName: "Buddy",
  species: "dog",
  about:
    "We got him at eight weeks and he never really stopped being a puppy. Terrible guard dog. " +
    "Slept through a break-in. He was with us thirteen years.",
  personality: "Gentle, stubborn, always hungry",
  memories:
    "He never once slept in the bed we bought him. Always the laundry basket, right on the warm " +
    "clothes. He waited by the front door twenty minutes before anyone got home, every single day. " +
    "He stole socks and buried them in the garden.",
  include: "Please include my daughter Ellie — he was really her dog. And please don't mention the illness.",
  style: "acoustic",
};

// ---------------------------------------------------------------------------
group("syllables");

ok("home is one syllable, not two (silent e)", countSyllables("home") === 1);
ok("basket is two", countSyllables("basket") === 2);
ok("little is two (le after a consonant)", countSyllables("little") === 2);
ok("walked is one (-ed not after t/d)", countSyllables("walked") === 1);
ok("wanted is two (-ed after t)", countSyllables("wanted") === 2);
ok(
  "a full line counts sensibly",
  countSyllables("He never once slept in the bed we bought him") >= 10,
  `got ${countSyllables("He never once slept in the bed we bought him")}`,
);

// ---------------------------------------------------------------------------
group("finding lines in what the owner wrote");

const candidates = candidatesFrom(BUDDY.memories, "memories");
ok("finds several candidates", candidates.length >= 4, `got ${candidates.length}`);
ok(
  "every candidate is singable (4-13 syllables)",
  candidates.every((c) => c.syllables >= 4 && c.syllables <= 13),
  candidates.map((c) => `${c.syllables}:${c.text}`).join(" | "),
);
ok(
  "a long sentence is also offered as a shorter clause",
  candidates.some((c) => c.text === "Always the laundry basket"),
  "expected the 13-syllable line to be split into a 7-syllable one",
);
ok(
  "the negation line outranks generic filler",
  (candidates[0]?.score ?? 0) > 0 &&
    candidates.slice(0, 4).some((c) => /never|thirteen|twenty/i.test(c.text)),
  candidates.slice(0, 4).map((c) => c.text).join(" | "),
);
ok("nothing is empty", candidates.every((c) => c.text.trim().length > 0));

// ---------------------------------------------------------------------------
group("the include field");

ok("pulls the person's name out", extractNames(BUDDY.include).includes("Ellie"));
ok(
  "does not treat sentence-starting stopwords as names",
  !extractNames("Please include my daughter Ellie.").includes("Please"),
);
ok(
  "catches what they asked us to leave out",
  extractExclusions(BUDDY.include).some((e) => /illness/i.test(e)),
  JSON.stringify(extractExclusions(BUDDY.include)),
);
ok("requiresBridge is true when a name was given", requiresBridge(BUDDY));
ok(
  "requiresBridge is false with no name",
  !requiresBridge({ ...BUDDY, include: "nothing in particular" }),
);

// ---------------------------------------------------------------------------
group("the brief");

const built = buildBrief(BUDDY);

ok("has a caption", built.brief.caption.length > 40);
ok(
  "caption carries no tempo or key (they have their own fields)",
  !/\b\d{2,3}\s*bpm\b|\bkey of\b/i.test(built.brief.caption),
  built.brief.caption,
);
ok("validates clean", validateBrief(built.brief).length === 0, validateBrief(built.brief).join("; "));
ok("no leftover placeholders", !built.brief.lyrics.includes("[write a line here"));
ok("duration is in a sane range", built.brief.durationSeconds >= 90 && built.brief.durationSeconds <= 240);

/**
 * THE REGRESSION THAT MATTERS.
 *
 * The brief is built in two passes — lyrics first, then the duration recomputed
 * from the lyrics that came out. The first version let that recomputed duration
 * fall to 120s, which dropped below the bridge threshold and silently deleted the
 * bridge. The bridge is where the daughter's name goes. The one thing the owner
 * explicitly asked for was being removed by a length calculation.
 */
ok(
  "the requested name survives into the lyrics",
  built.brief.lyrics.includes("Ellie"),
  built.brief.lyrics,
);
ok("there is a bridge to hold it", built.brief.lyrics.includes("[Bridge]"));
ok(
  "duration is floored so the bridge fits",
  built.brief.durationSeconds >= 180,
  `got ${built.brief.durationSeconds}`,
);

ok(
  "the chorus is always flagged as invented",
  built.warnings.some((w) => /chorus/i.test(w)),
  built.warnings.join(" | "),
);
ok(
  "the exclusion is surfaced as a warning",
  built.warnings.some((w) => /illness/i.test(w)),
  built.warnings.join(" | "),
);
ok(
  "verses are built from the owner's own words",
  ["laundry basket", "thirteen years", "bed we bought", "socks"].filter((phrase) =>
    built.brief.lyrics.toLowerCase().includes(phrase),
  ).length >= 3,
  built.brief.lyrics,
);
ok(
  "structure tags are present and ordered",
  /\[Intro\][\s\S]*\[Verse 1\][\s\S]*\[Chorus\][\s\S]*\[Outro\]/.test(built.brief.lyrics),
);
ok(
  "title comes from their words, not a template",
  built.brief.title !== "For Buddy" && built.brief.title.length > 3,
  built.brief.title,
);

// ---------------------------------------------------------------------------
group("thin answers still produce something honest");

const THIN: Answers = { petName: "Milo", memories: "He sat on the windowsill." };
const thin = buildBrief(THIN);
ok("still builds", thin.brief.lyrics.length > 40);
ok(
  "admits it could not fill the verses",
  validateBrief(thin.brief).length > 0 || thin.warnings.length > 0,
  "expected placeholders or warnings",
);
ok(
  "validateBrief refuses a brief with placeholders",
  !thin.brief.lyrics.includes("[write a line here") ||
    validateBrief(thin.brief).some((p) => /placeholder/i.test(p)),
  validateBrief(thin.brief).join("; "),
);

group("empty lyrics and bad input are rejected");
ok(
  "empty caption is caught",
  validateBrief({ ...built.brief, caption: "" }).some((p) => /caption/i.test(p)),
);
ok(
  "empty lyrics are caught",
  validateBrief({ ...built.brief, lyrics: "" }).some((p) => /lyrics/i.test(p)),
);
ok(
  "an absurd duration is caught",
  validateBrief({ ...built.brief, durationSeconds: 5000 }).some((p) => /duration/i.test(p)),
);
ok(
  "an absurd bpm is caught",
  validateBrief({ ...built.brief, bpm: 999 }).some((p) => /bpm/i.test(p)),
);
ok("a missing name throws rather than guessing", (() => {
  try {
    buildBrief({ petName: "", memories: "x" });
    return false;
  } catch {
    return true;
  }
})());

// ---------------------------------------------------------------------------
group("structure follows the length");

ok("a short song has no bridge", !buildLyrics({ ...BUDDY, include: "" }, 95).lyrics.includes("[Bridge]"));
ok("a long song has one", buildLyrics({ ...BUDDY, include: "" }, 200).lyrics.includes("[Bridge]"));
ok(
  "a very long song adds an instrumental",
  buildLyrics({ ...BUDDY, include: "" }, 240).lyrics.includes("[Guitar Solo]"),
);
ok(
  "suggestDuration stays in range",
  (() => {
    const d = suggestDuration(built.brief.lyrics, 68);
    return d >= 90 && d <= 240;
  })(),
);

// ---------------------------------------------------------------------------
group("audio probing");

/** A minimal valid 8-bit mono RIFF/WAVE header describing one second at 8kHz. */
function fakeWav(seconds: number, rate = 8000): Buffer {
  const dataSize = seconds * rate;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // byte rate
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < dataSize; i += 1) buf[44 + i] = Math.floor(Math.random() * 256);
  return buf;
}

const wav = fakeWav(3);
ok("measures a wav's duration", Math.abs(probeAudio(wav).approxDurationSeconds - 3) < 0.2,
  String(probeAudio(wav).approxDurationSeconds));
ok("random noise passes the sanity check", looksLikeAudio(wav).ok, looksLikeAudio(wav).detail);
ok(
  "digital silence fails it",
  !looksLikeAudio(Buffer.alloc(200_000)).ok,
  looksLikeAudio(Buffer.alloc(200_000)).detail,
);
ok("a truncated file fails it", !looksLikeAudio(Buffer.alloc(100)).ok);
ok(
  "an unknown container reports zero rather than guessing",
  probeAudio(Buffer.from("not audio at all")).approxDurationSeconds === 0,
);

// ---------------------------------------------------------------------------
console.log(
  `\n${failures === 0 ? "ALL" : `${checks - failures}/${checks}`} ${checks} checks${
    failures === 0 ? " passed" : `, ${failures} FAILED`
  }`,
);
process.exit(failures === 0 ? 0 : 1);
