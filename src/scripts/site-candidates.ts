/**
 * Candidates for the two site examples that didn't land.
 *
 *   node --experimental-strip-types src/scripts/site-candidates.ts <out-dir> [id...]
 *
 * Feedback was that Buddy and Charlie were good, and that Milo and Luna had "a
 * sharp echo that makes it sound like AI". That is diagnosable rather than bad
 * luck, and the diagnosis is in my own captions:
 *
 *   Milo had "wide warm room" — a direct request for reverb.
 *   Luna had "hushed close harmonies" — a doubled vocal, which the model renders
 *     with phase artefacts that read as metallic ringing.
 *   Both had "breathy", which tends to come back as sibilance.
 *
 * Buddy and Charlie had none of those. They said "close-miked", "intimate",
 * "spacious" — spacious describes an arrangement, not a reverb tail — and neither
 * asked for harmonies or breath.
 *
 * So every candidate here states the absence explicitly: dry, close-miked, no
 * reverb, single tracked vocal, no harmonies. Negative terms are worth including
 * even though the model honours them imperfectly, because the alternative is
 * leaving the space unspecified and letting it choose.
 *
 * The other change is vocal gender. Both tracks that failed were female and both
 * that worked were male, so most candidates move to male. That is a real loss of
 * range across the four examples, so one candidate keeps a female vocal with all
 * the reverb and harmony language stripped out — that one is the experiment that
 * tells us whether the voice was ever the problem or whether it was always the
 * room.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.ts";
import { probeAudio, looksLikeAudio } from "../audio.ts";

type Candidate = {
  /** `<pet>-<variant>` — the filename is the audition label. */
  id: string;
  pet: "milo" | "luna";
  /** One line for the human choosing between these. */
  note: string;
  duration: number;
  bpm: number;
  keyScale: string;
  caption: string;
  lyrics: string;
};

const MILO_LYRICS = `[Intro]

[Verse 1]
Eleven years of listening
For tyres on the drive
You knew the sound before I did
You knew when I'd arrive

[Chorus]
Wait for me at the door
The way you always would
Wait for me at the door
I'm coming home for good

[Outro]
Wait for me`;

const LUNA_LYRICS = `[Verse 1]
Sixteen years, one step behind
Room to room, close and slow
Never asking, never far
My little shadow

[Chorus]
Still I feel you at my heel
Still I turn to see
Little shadow, little shadow
Still one step from me

[Outro]
Little shadow`;

/** Appended to every caption. The point of this whole pass. */
const DRY = "dry, close-miked, no reverb, no echo, single tracked vocal, no harmonies, no double tracking";

const CANDIDATES: Candidate[] = [
  // ── Milo ────────────────────────────────────────────────────────────────
  {
    id: "milo-a-piano-male",
    pet: "milo",
    note: "The original piano idea with the room taken out and a male voice.",
    duration: 45,
    bpm: 62,
    keyScale: "C Major",
    caption:
      `solo piano ballad, felt piano, soft sustain, warm low male vocal, ` +
      `slow, reflective, restrained, no drums, no strings, ${DRY}`,
    lyrics: MILO_LYRICS,
  },
  {
    id: "milo-b-reggae",
    pet: "milo",
    note: "Roots reggae, as suggested. Genuinely different from the other three.",
    duration: 45,
    bpm: 74,
    keyScale: "A Minor",
    caption:
      `gentle roots reggae, warm offbeat guitar skank, deep melodic bassline, ` +
      `soft hand percussion, mellow hammond organ pad, warm male vocal, ` +
      `unhurried, sunlit and mournful, vintage analogue warmth, ${DRY}`,
    lyrics: MILO_LYRICS,
  },
  {
    id: "milo-c-soul-organ",
    pet: "milo",
    note: "Slow soul with a Hammond. Warm, and the furthest thing from sterile.",
    duration: 45,
    bpm: 66,
    keyScale: "F Major",
    caption:
      `slow soul ballad, warm hammond organ, muted electric guitar, soft brushed drums, ` +
      `round upright bass, honest male vocal, gentle and unhurried, ` +
      `vintage soul recording, ${DRY}`,
    lyrics: MILO_LYRICS,
  },

  // ── Luna ────────────────────────────────────────────────────────────────
  {
    id: "luna-a-nylon-male",
    pet: "luna",
    note: "The original folk idea with the harmonies removed and a male voice.",
    duration: 40,
    bpm: 74,
    keyScale: "D Major",
    caption:
      `soft folk lament, nylon-string guitar, quiet fiddle, warm male vocal, ` +
      `delicate and small-scale, pastoral, unhurried, no drums, ${DRY}`,
    lyrics: LUNA_LYRICS,
  },
  {
    id: "luna-b-reggae",
    pet: "luna",
    note: "Reggae again, lighter and smaller — she was a cat.",
    duration: 40,
    bpm: 72,
    keyScale: "G Major",
    caption:
      `gentle roots reggae ballad, soft offbeat guitar, round warm bassline, ` +
      `light shaker and rimshot, warm male vocal, tender, unhurried, small-scale, ` +
      `vintage analogue warmth, ${DRY}`,
    lyrics: LUNA_LYRICS,
  },
  {
    id: "luna-c-female-dry",
    pet: "luna",
    note:
      "THE EXPERIMENT: female vocal kept, but every reverb and harmony word removed. " +
      "If this one is clean, the room was the problem and not the voice — which means " +
      "the four examples can keep a female voice among them.",
    duration: 40,
    bpm: 74,
    keyScale: "D Major",
    caption:
      `soft folk lament, nylon-string guitar, quiet fiddle, warm female vocal, ` +
      `plain and unaffected, delicate and small-scale, pastoral, unhurried, no drums, ${DRY}`,
    lyrics: LUNA_LYRICS,
  },

  // ── wider styles ────────────────────────────────────────────────────────
  //
  // Asked for more range. These leave the acoustic-ballad register entirely,
  // which is the point — but a memorial song has one hard constraint that a
  // genre label can quietly break: it cannot be cheerful. So every one of these
  // is the slow, warm, minor-leaning end of its style, and none of them gets a
  // backbeat you could nod along to.
  {
    id: "milo-d-bossa",
    pet: "milo",
    note: "Soft bossa nova. Warm and unhurried, and nothing like the other three.",
    duration: 45,
    bpm: 68,
    keyScale: "A Minor",
    caption:
      `soft bossa nova ballad, warm nylon-string guitar, gentle brushed drums, ` +
      `round upright bass, quiet vibraphone, warm low male vocal, ` +
      `intimate late-night feel, vintage analogue warmth, unhurried, ${DRY}`,
    lyrics: MILO_LYRICS,
  },
  {
    id: "milo-e-gospel-soul",
    pet: "milo",
    note: "Slow gospel-soul, single voice. Warmth without the choir.",
    duration: 45,
    bpm: 60,
    keyScale: "E Flat Major",
    caption:
      `slow gospel soul ballad, warm upright piano, hammond organ swell, ` +
      `soft brushed drums, round electric bass, honest full male vocal, ` +
      `sincere and unhurried, vintage recording, no choir, no backing vocals, ${DRY}`,
    lyrics: MILO_LYRICS,
  },
  {
    id: "luna-d-lofi",
    pet: "luna",
    note: "Bedroom lo-fi. Small and close, tape hiss instead of reverb.",
    duration: 40,
    bpm: 72,
    keyScale: "F Major",
    caption:
      `quiet bedroom lo-fi ballad, muted electric guitar, soft rhodes piano, ` +
      `warm tape hiss, gentle male vocal almost spoken, small and intimate, ` +
      `slow, unhurried, no drums, ${DRY}`,
    lyrics: LUNA_LYRICS,
  },
  {
    id: "luna-e-slide-blues",
    pet: "luna",
    note: "Slow blues with slide guitar. The most human-sounding option here.",
    duration: 40,
    bpm: 64,
    keyScale: "E Major",
    caption:
      `slow acoustic blues lament, resonator slide guitar, fingerpicked acoustic guitar, ` +
      `soft upright bass, warm weathered male vocal, front-porch feel, ` +
      `unhurried, sparse, no drums, vintage analogue warmth, ${DRY}`,
    lyrics: LUNA_LYRICS,
  },
];

const MAX_ATTEMPTS = 8;

async function generate(c: Candidate): Promise<Buffer> {
  const payload = {
    model: "acemusic/acestep-v1.5-turbo",
    messages: [
      {
        role: "user",
        content: `<prompt>${c.caption}</prompt><lyrics>${c.lyrics}</lyrics>`,
      },
    ],
    stream: false,
    thinking: false,
    use_format: false,
    audio_config: {
      duration: c.duration,
      bpm: c.bpm,
      key_scale: c.keyScale,
      format: "mp3",
      vocal_language: "en",
    },
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const res = await fetch(`${config.acemusic.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.acemusic.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(70_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const parsed = (await res.json()) as {
        choices?: Array<{ message?: { audio?: Array<{ audio_url?: { url?: string } }> } }>;
      };
      const uri = parsed.choices?.[0]?.message?.audio?.[0]?.audio_url?.url;
      if (!uri) throw new Error("200 but no audio");

      const audio = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
      const sanity = looksLikeAudio(audio);
      if (!sanity.ok) throw new Error(`sanity check failed (${sanity.detail})`);
      const probe = probeAudio(audio);
      if (Math.abs(probe.approxDurationSeconds - c.duration) > c.duration * 0.2) {
        throw new Error(`came back ${probe.approxDurationSeconds}s, asked ${c.duration}s`);
      }

      console.log(
        `  ${c.id.padEnd(20)} ok in ${String(Math.round((Date.now() - started) / 1000)).padStart(2)}s · ` +
          `${probe.approxDurationSeconds}s · ${(audio.byteLength / 1024).toFixed(0)}KB`,
      );
      return audio;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`${c.id}: ${(err as Error).message}`);
      const wait = Math.round(
        Math.min(60_000, 4_000 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5),
      );
      console.log(
        `  ${c.id.padEnd(20)} attempt ${attempt}/${MAX_ATTEMPTS} failed ` +
          `(${(err as Error).message}) — retry in ${Math.round(wait / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

const outDir = resolve(process.argv[2] ?? "./candidates");
mkdirSync(outDir, { recursive: true });

const only = process.argv.slice(3);
const todo = CANDIDATES.filter((c) => {
  if (only.length > 0 && !only.some((o) => c.id.includes(o))) return false;
  const path = join(outDir, `${c.id}.mp3`);
  if (existsSync(path) && statSync(path).size > 8_000) {
    console.log(`  ${c.id.padEnd(20)} already there, skipping`);
    return false;
  }
  return true;
});

console.log(`\nGenerating ${todo.length} candidates into ${outDir}\n`);

const failed: string[] = [];
for (const c of todo) {
  try {
    writeFileSync(join(outDir, `${c.id}.mp3`), await generate(c));
  } catch (err) {
    console.log(`  ${(err as Error).message}`);
    failed.push(c.id);
  }
}

console.log("\nListen and pick one per pet:\n");
for (const pet of ["milo", "luna"] as const) {
  console.log(`  ${pet.toUpperCase()}`);
  for (const c of CANDIDATES.filter((x) => x.pet === pet)) {
    console.log(`    ${c.id.padEnd(20)} ${c.note}`);
  }
  console.log();
}
if (failed.length) {
  console.log(`  still missing: ${failed.join(", ")} — run again, it resumes.`);
  process.exit(1);
}
