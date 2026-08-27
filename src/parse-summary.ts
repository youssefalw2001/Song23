/**
 * Turning a pasted email back into answers.
 *
 * The realistic input to this service is a block of text in an inbox. With no
 * form endpoint configured, the site's Create flow shows the customer a formatted
 * summary and invites them to email it — so that text, not a tidy JSON payload,
 * is what actually arrives. Being able to paste it is the difference between
 * using this and retyping someone's account of their dead pet by hand.
 *
 * The labels must stay in step with `LABELS` in the site's `lib/questions.ts`.
 * They are duplicated rather than shared because the two repos don't import from
 * each other, and a wrong label degrades to "field not recognised" rather than to
 * anything dangerous.
 */

import type { Answers } from "./types.ts";

const LABELS: Record<string, string> = {
  petName: "Their name",
  species: "Dog or cat",
  about: "About them",
  personality: "What they were like",
  memories: "Never want to forget",
  include: "To include or avoid",
  style: "Preferred sound",
  photoNames: "Photos attached",
  yourName: "Your name",
  email: "Email",
};

const FIELD_BY_LABEL = new Map(
  Object.entries(LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

export function parseSummary(text: string): {
  answers: Partial<Answers>;
  matched: string[];
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const answers: Record<string, string> = {};
  const matched: string[] = [];

  let currentField: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentField) {
      const value = buffer.join("\n").trim();
      if (value) {
        answers[currentField] = value;
        matched.push(currentField);
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    // A line that is exactly a known label and a colon starts a field. Splitting
    // on blank lines instead would be simpler and would break the moment
    // someone's paragraph about their dog contains one, which it will.
    const heading = /^\s*([A-Za-z][A-Za-z /']{2,40}):\s*$/.exec(line);
    const field = heading ? FIELD_BY_LABEL.get(heading[1]!.trim().toLowerCase()) : undefined;

    if (field) {
      flush();
      currentField = field;
      continue;
    }

    // Some mail clients reflow "Label: value" onto a single line.
    const inline = /^\s*([A-Za-z][A-Za-z /']{2,40}):\s+(.+)$/.exec(line);
    if (inline) {
      const inlineField = FIELD_BY_LABEL.get(inline[1]!.trim().toLowerCase());
      if (inlineField) {
        flush();
        answers[inlineField] = inline[2]!.trim();
        matched.push(inlineField);
        currentField = null;
        continue;
      }
    }

    if (currentField) buffer.push(line);
  }
  flush();

  // Both are constrained sets in the form; normalise the display text back to
  // the values the songwriting layer expects.
  if (answers.species) {
    const s = answers.species.toLowerCase();
    answers.species = s.includes("dog") ? "dog" : s.includes("cat") ? "cat" : "other";
  }
  if (answers.style) {
    const s = answers.style.toLowerCase();
    answers.style =
      s.includes("piano") ? "piano"
      : s.includes("folk") ? "folk"
      : s.includes("country") ? "country"
      : s.includes("acoustic") ? "acoustic"
      : "unsure";
  }

  // In the summary, but not an input to the song.
  delete answers.photoNames;

  return { answers: answers as Partial<Answers>, matched };
}

export { LABELS };
