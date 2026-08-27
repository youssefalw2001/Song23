/**
 * Print the brief for a set of answers, without generating anything.
 *
 * The point of this script is to make the songwriting layer inspectable in a
 * second, so it can be iterated on cheaply. Generating audio takes 20 seconds and
 * a slot in someone else's GPU queue; reading a lyric takes neither.
 *
 *   node --experimental-strip-types src/scripts/brief-preview.ts
 *   node --experimental-strip-types src/scripts/brief-preview.ts answers.json
 */

import { readFileSync } from "node:fs";
import { buildBrief, validateBrief } from "../songwriting/brief.ts";
import type { Answers } from "../types.ts";

/** A realistic case, close to what the form's own placeholder text invites. */
const EXAMPLE: Answers = {
  petName: "Buddy",
  species: "dog",
  about:
    "We got him at eight weeks and he never really stopped being a puppy. Terrible guard dog. " +
    "Slept through a break-in. He was with us thirteen years and he was my dad's shadow for " +
    "every one of them.",
  personality: "Gentle, stubborn, always hungry",
  memories:
    "He never once slept in the bed we bought him. Always the laundry basket, right on the warm " +
    "clothes. He waited by the front door twenty minutes before anyone got home, every single " +
    "day, and we never worked out how he knew. He stole socks and buried them in the garden.",
  include: "Please include my daughter Ellie — he was really her dog. And please don't mention the illness.",
  style: "acoustic",
  yourName: "Youssef",
  email: "someone@example.com",
};

const path = process.argv[2];
const answers: Answers = path
  ? (JSON.parse(readFileSync(path, "utf8")) as Answers)
  : EXAMPLE;

const { brief, warnings, notes, unusedLines } = buildBrief(answers);

const rule = (label: string) => `\n${"─".repeat(72)}\n${label}\n${"─".repeat(72)}`;

console.log(rule("BRIEF"));
console.log(`title      ${brief.title}`);
console.log(`duration   ${brief.durationSeconds}s`);
console.log(`bpm        ${brief.bpm}`);
console.log(`key        ${brief.keyScale}`);
console.log(`time sig   ${brief.timeSignature}`);

console.log(rule("CAPTION (what the model listens to hardest)"));
console.log(brief.caption);

console.log(rule("LYRICS"));
console.log(brief.lyrics);

console.log(rule("NOTES"));
for (const note of notes) console.log(`  · ${note}`);

console.log(rule("WARNINGS — a human must clear these"));
if (warnings.length === 0) console.log("  none");
for (const warning of warnings) console.log(`  ! ${warning}`);

console.log(rule("UNUSED LINES FROM THEIR OWN WRITING (alternates)"));
if (unusedLines.length === 0) console.log("  none");
for (const line of unusedLines) {
  console.log(`  ${String(line.syllables).padStart(2)} syl  score ${String(line.score).padStart(3)}  ${line.text}`);
}

const problems = validateBrief(brief);
console.log(rule("VALIDATION"));
console.log(problems.length === 0 ? "  ready to generate" : problems.map((p) => `  ✗ ${p}`).join("\n"));
console.log();
