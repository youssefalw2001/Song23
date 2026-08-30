/**
 * Generate the four example songs for the public site.
 *
 *   node --experimental-strip-types src/scripts/site-examples.ts <out-dir>
 *
 * These are not built by the songwriting layer, and that is deliberate. That
 * layer's whole premise is that a customer's own sentences beat anything
 * generated — it takes prose someone wrote about their pet and finds the singable
 * lines in it. There is no such prose here: these four animals are illustrations
 * with a name, a title and one line of copy. So the lyrics are written by hand,
 * which is what the layer would tell you to do anyway.
 *
 * The four briefs are deliberately unalike. Four ballads that share a tempo, a
 * key and an instrument would read as one song rendered four times, which is
 * worse than having one example — it would suggest the service produces a
 * template. So: guitar, piano, fiddle, pedal steel; male, female, hushed,
 * plain-spoken; four tempos, four keys; and only one of them has drums.
 *
 * Every lyric is kept to 6–10 syllables a line and one metaphor per song, and
 * each one is built out of the specific detail already in that pet's line in
 * lib/content.ts — thirteen years and the bed he never used, eleven years of
 * listening for the car, sixteen years one step behind, four houses and three
 * cities. The copy on the site and the words in the song should be the same story.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.ts";
import { probeAudio, looksLikeAudio } from "../audio.ts";

type Example = {
  id: string;
  /** Seconds. 30–60 keeps an example an example rather than a demand. */
  duration: number;
  bpm: number;
  keyScale: string;
  caption: string;
  lyrics: string;
};

/**
 * Appended to every caption, and the single most useful thing in this file.
 *
 * The first pass at Milo and Luna came back with a metallic ringing that read
 * instantly as machine-made. The cause was not the model — it was in my captions.
 * One asked for a "wide warm room", which is a request for reverb written out in
 * words; the other for "hushed close harmonies", which is a doubled vocal, and
 * doubling comes back with phase artefacts. Both said "breathy", which arrives as
 * sibilance. Buddy and Charlie, which were fine first time, said "close-miked"
 * and "intimate" and asked for neither.
 *
 * Stating the absence is worth doing even though the model honours negatives
 * imperfectly, because the alternative is leaving the space unspecified and
 * letting it choose one. If a generated vocal ever sounds artificial, look here
 * before blaming the model.
 */
const DRY =
  "dry, close-miked, no reverb, no echo, single tracked vocal, no harmonies, no double tracking";

const EXAMPLES: Example[] = [
  {
    // The featured track, so the fullest arrangement of the four — but still
    // drumless. A memorial song with a backbeat is a different product.
    id: "buddy",
    duration: 55,
    bpm: 68,
    keyScale: "G Major",
    caption:
      "gentle acoustic memorial ballad, fingerpicked steel-string guitar, soft warm male vocal, " +
      "sparse upright bass, close-miked and intimate, unhurried, tender, no drums, " +
      "warm analogue recording, quiet room",
    lyrics: `[Intro]

[Verse 1]
Thirteen years of muddy paws
A basket by the door
You never used the bed we bought
Just warm clothes on the floor

[Chorus]
You were always home
Never the house, just you
You were always home
And somehow you always knew

[Outro]
Always home`,
  },
  {
    // Gospel-soul, chosen by ear over four alternatives.
    //
    // This slot was originally felt piano with a breathy female vocal in a "wide
    // warm room", and it came back with a metallic ring that read instantly as
    // machine-made. "Wide warm room" is a request for reverb written out in words.
    // The replacement names no space at all and says so explicitly.
    id: "milo",
    duration: 45,
    bpm: 60,
    keyScale: "E Flat Major",
    caption:
      "slow gospel soul ballad, warm upright piano, hammond organ swell, " +
      "soft brushed drums, round electric bass, honest full male vocal, " +
      "sincere and unhurried, vintage recording, no choir, no backing vocals, " +
      DRY,
    lyrics: `[Intro]

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
Wait for me`,
  },
  {
    // Resonator slide blues, chosen by ear over four alternatives.
    //
    // Originally nylon strings, a fiddle and "hushed close harmonies" — and the
    // harmonies were the problem: a doubled vocal comes back with phase artefacts
    // that ring. Luna was a cat, so this stays sparse and small; slide guitar
    // carries the weight so the voice can stay plain.
    id: "luna",
    duration: 40,
    bpm: 64,
    keyScale: "E Major",
    caption:
      "slow acoustic blues lament, resonator slide guitar, fingerpicked acoustic guitar, " +
      "soft upright bass, warm weathered male vocal, front-porch feel, " +
      "unhurried, sparse, no drums, vintage analogue warmth, " +
      DRY,
    lyrics: `[Verse 1]
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
Little shadow`,
  },
  {
    // The only one with any percussion, and only brushes. Pedal steel does the
    // emotional work so the vocal can stay plain.
    id: "charlie",
    duration: 50,
    bpm: 72,
    keyScale: "G Major",
    caption:
      "quiet country ballad, pedal steel guitar, acoustic guitar, soft brushed drums, " +
      "warm honest male vocal, spacious, sincere, unhurried, no twang, no fiddle",
    lyrics: `[Intro]

[Verse 1]
Four houses and three cities
Boxes in the hall
You found the sunlight every time
Before we'd unpacked at all

[Chorus]
Home was wherever you were
Never brick, never door
Home was wherever you were
And it isn't anymore

[Outro]
Wherever you were`,
  },
];

const MAX_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 70_000;

async function generate(example: Example): Promise<Buffer> {
  const payload = {
    model: "acemusic/acestep-v1.5-turbo",
    messages: [
      {
        role: "user",
        // The XML tags are not optional: without them `duration` is discarded
        // and the request is rerouted into a mode that writes its own lyrics.
        content: `<prompt>${example.caption}</prompt><lyrics>${example.lyrics}</lyrics>`,
      },
    ],
    stream: false,
    // False, always. With thinking on, the hosted endpoint 504s at its 60s
    // gateway timeout even for short requests.
    thinking: false,
    use_format: false,
    audio_config: {
      duration: example.duration,
      bpm: example.bpm,
      key_scale: example.keyScale,
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 80);
        throw new Error(`HTTP ${res.status} ${body.replace(/\s+/g, " ")}`);
      }

      const parsed = (await res.json()) as {
        choices?: Array<{ message?: { audio?: Array<{ audio_url?: { url?: string } }> } }>;
      };
      const uri = parsed.choices?.[0]?.message?.audio?.[0]?.audio_url?.url;
      if (!uri) throw new Error("200 but no audio in the response");

      const audio = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");

      const sanity = looksLikeAudio(audio);
      if (!sanity.ok) throw new Error(`failed the sanity check (${sanity.detail})`);

      const probe = probeAudio(audio);
      const drift = Math.abs(probe.approxDurationSeconds - example.duration);
      if (drift > example.duration * 0.2) {
        throw new Error(
          `came back ${probe.approxDurationSeconds}s, asked for ${example.duration}s`,
        );
      }

      console.log(
        `  ${example.id}: ok in ${Math.round((Date.now() - started) / 1000)}s · ` +
          `${probe.approxDurationSeconds}s · ${(audio.byteLength / 1024).toFixed(0)}KB · ` +
          `${probe.detail} · ${sanity.detail}`,
      );
      return audio;
    } catch (err) {
      const message = (err as Error).message;
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${example.id} failed after ${MAX_ATTEMPTS} attempts: ${message}`);
      }
      const wait = Math.round(Math.min(60_000, 4_000 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5));
      console.log(
        `  ${example.id}: attempt ${attempt}/${MAX_ATTEMPTS} failed after ${elapsed}s ` +
          `(${message}) — retrying in ${Math.round(wait / 1000)}s`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error("unreachable");
}

const outDir = resolve(process.argv[2] ?? "./site-songs");
mkdirSync(outDir, { recursive: true });

/**
 * Resumable, because the free endpoint goes through episodes where nothing gets
 * through for ten minutes at a time. Re-running should cost only what is still
 * missing — regenerating a track that already came out well, and might come out
 * worse, is the wrong default. Delete a file to force it.
 */
const only = process.argv.slice(3).filter((a) => !a.startsWith("-"));
const todo = EXAMPLES.filter((e) => {
  if (only.length > 0 && !only.includes(e.id)) return false;
  const path = join(outDir, `${e.id}.mp3`);
  if (existsSync(path) && statSync(path).size > 8_000) {
    console.log(`  ${e.id}: already there, skipping`);
    return false;
  }
  return true;
});

console.log(`Generating ${todo.length} of ${EXAMPLES.length} example songs into ${outDir}\n`);

const results: { id: string; seconds: number; bytes: number }[] = [];
const failed: string[] = [];

// One at a time. The bottleneck is a shared, oversubscribed GPU pool; firing
// four requests at it turns one slow success into four timeouts.
for (const example of todo) {
  try {
    const audio = await generate(example);
    const path = join(outDir, `${example.id}.mp3`);
    writeFileSync(path, audio);
    results.push({
      id: example.id,
      seconds: probeAudio(audio).approxDurationSeconds,
      bytes: audio.byteLength,
    });
  } catch (err) {
    // One track exhausting its retries must not discard the ones that worked.
    console.log(`  ${(err as Error).message}`);
    failed.push(example.id);
  }
}

console.log("\nFor lib/content.ts:\n");
for (const r of results) {
  console.log(`  ${r.id}:  src: "/songs/${r.id}.mp3",  length: ${Math.round(r.seconds)},`);
}
console.log(
  `\n  ${results.length} generated, ${(results.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(1)} MB`,
);

if (failed.length > 0) {
  console.log(`\n  still missing: ${failed.join(", ")} — run again, it resumes.`);
  process.exit(1);
}
