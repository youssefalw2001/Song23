# tails-song-api

The song service behind [Tails We Remember](https://github.com/youssefalw2001/Petting-).
Takes a family's answers about their pet and produces a finished memorial song.

Zero runtime dependencies. Node 22+, TypeScript, `node:http`.

```bash
npm install
cp .env.example .env      # then fill in ACE_API_KEY and OPERATOR_TOKEN
npm run build && npm start
```

Generate an operator token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## GitHub Pages cannot host this

Pages serves static files; it never runs a process. This service is a process — it
listens on a port, holds a queue, retries on a timer and writes audio to disk.

That is the same constraint that makes this repo necessary in the first place: the
site is a static export on Pages, which is why it has nowhere to keep an API key
and no way to call an endpoint that refuses cross-origin requests.

Pages hosts the studio page, at `/studio/` on the site. Render (or Docker, or your
laptop) hosts this. There's a `render.yaml` and a `Dockerfile` —
see **[docs/DEPLOY.md](docs/DEPLOY.md)**, including the part about Render's free
filesystem being wiped on every deploy.

## Why this is a separate service at all

Three reasons, in order of how quickly they stop you:

1. **A browser cannot call the ACE endpoint.** It sends no CORS headers and its
   preflight doesn't answer. The site is a static export, so without something in
   the middle there is no path from a page to a song.
2. **There is nowhere on the site to keep a key.** A static export bakes its env
   vars into public JavaScript, and its build runs in a public Actions workflow.
3. **The upstream API is synchronous behind a 60-second gateway timeout, and
   fails often.** The same valid request has succeeded twice and then returned 504
   six times running. Something has to own retrying that, and it cannot be a tab
   that someone might close.

## The shape of it

```
answers ──▶ brief (caption + lyrics) ──▶ [ a human reads it ] ──▶ queue ──▶ song
```

The brief is the point. Building it is instant and free; generating audio takes
twenty seconds and is irreversible in the sense that matters — you cannot unsend a
song to someone whose dog died last week. So `POST /jobs` deliberately does *not*
generate. It writes the brief and stops.

```
src/
  ace/
    provider.ts     the interface, ProviderError, retry policy
    acemusic.ts     ACE Music's free hosted endpoint
    selfhosted.ts   your own ACE-Step 1.5 server
  songwriting/
    lines.ts        finds singable lines in what the owner wrote
    syllables.ts    counts them, because 6–10 per line sings and 14 doesn't
    caption.ts      style presets — the input ACE weights most heavily
    lyrics.ts       assembles the draft; picks one metaphor; flags what it invented
    brief.ts        answers ──▶ reviewable brief
  jobs/
    store.ts        data/jobs/<id>/{job.json, take-N.mp3}
    queue.ts        one at a time, six attempts, jittered backoff
  http/server.ts    nine routes
```

## The songwriting layer

This is where song quality actually lives, and it is deliberately conservative.

**The verses are the owner's own sentences.** "He never once slept in the bed we
bought him" is a lyric already — specific, true, and something no model would
invent. `lines.ts` splits what they wrote into clauses, scores them for
concreteness (physical nouns, numbers, negations) against vagueness ("love",
"forever", "heart"), filters to what fits a bar, and ranks them. Lines that don't
make the draft are offered as alternates rather than discarded.

**The chorus is the only invented text**, because a chorus repeats and prose
doesn't. It is built from one motif chosen out of the owner's own words — the door
they waited at, the spot that was theirs, the walk — so the metaphor is still
theirs. It is also flagged in `warnings` every single time, because it is the most
repeated and least personal part of the song.

**ACE is never allowed to write lyrics.** `use_format: true` was tested. Given "he
slept in the laundry basket and never in his bed. thirteen years" it returned
"Twenty years. We miss him.Thirty." and a verse reading "PDm, 12:28, 12:28,
12:28". See [docs/ACE-MUSIC-API.md](docs/ACE-MUSIC-API.md).

Preview a brief without spending a generation:

```bash
npm run brief                 # a worked example
npm run brief answers.json    # your own
npm run check                 # 46 assertions, no key, no network
```

`warnings` is not decoration. It is the list of things a human has to clear —
placeholder lines, a chorus worth rewriting, lines too long to sing, and anything
the family asked you to leave out.

## Routes

All except `/health` need `Authorization: Bearer $OPERATOR_TOKEN`.

| | | |
|---|---|---|
| `GET` | `/health` | liveness, no auth |
| `GET` | `/status` | provider reachability, queue depth, the `thinking` flag |
| `POST` | `/brief` | build a brief and throw it away. Costs nothing |
| `GET` | `/jobs` | every job, newest first |
| `POST` | `/jobs` | create from answers. **Does not generate** |
| `GET` | `/jobs/:id` | one job, with attempt history |
| `POST` | `/jobs/:id/generate` | generate. Body may override the brief |
| `GET` | `/jobs/:id/audio` | latest take. Supports Range |
| `GET` | `/jobs/:id/audio/take-N.mp3` | a specific take |

Responses never include the customer's email — `hasEmail: true` instead.

```bash
TOKEN=...
curl -s localhost:8787/jobs -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "petName": "Buddy",
    "memories": "He never once slept in the bed we bought him. Always the laundry basket.",
    "include": "Please include my daughter Ellie.",
    "style": "acoustic"
  }'
# then read the lyrics, then:
curl -s -XPOST localhost:8787/jobs/<id>/generate -H "Authorization: Bearer $TOKEN"
```

## The queue

One generation at a time, and that is a policy rather than a simplification. The
bottleneck is a shared, oversubscribed GPU pool; firing three requests at it turns
one slow success into three timeouts.

Six attempts with exponential backoff and full jitter, spanning roughly ten
minutes. Non-retryable failures — an empty caption, a brief with placeholders still
in it — fail immediately rather than burning ten minutes to tell you the same
thing. Every attempt is recorded on the job, including the ones that 504'd.

Takes are never overwritten. Take three is often better than take five, and
searching for the right one shouldn't be lossy.

## Switching to your own GPU

```bash
MUSIC_PROVIDER=selfhosted
SELFHOSTED_BASE_URL=http://your-box:8001
SELFHOSTED_API_KEY=...            # unset means NO AUTH, not no access
SELFHOSTED_AUDIO_FORMAT=wav
```

You get the native async API and therefore no 60-second ceiling, `thinking: true`
becomes usable, and wav instead of 128kbps mp3.

You also get clear rights to the output, which is the part that actually matters.
Nobody upstream ever answered whether *hosted* output can be sold —
[#1238](https://github.com/ace-step/ACE-Step-1.5/issues/1238) was asked, ignored,
and closed by a stale bot. The MIT licence unambiguously covers weights you run
yourself. **Read acemusic.ai's terms or self-host before taking money.**

The self-hosted adapter is written from the upstream API docs and has not been run
against a real server yet. It fails loudly and specifically on purpose.

## Operational notes

- `ACE_THINKING` defaults to `false`, against upstream's default, and this is the
  single most important setting in the file. See
  [docs/ACE-MUSIC-API.md](docs/ACE-MUSIC-API.md#1-thinking-false-is-what-makes-full-length-songs-possible).
- `/status` reporting the provider as reachable means the host answered, nothing
  more. `/health` upstream stays 200 through total generation failure.
- `data/` holds customer answers and audio. Gitignored. Back it up like the
  liability it is.
- Logs redact anything whose field name looks like a key, token or email.
- The service refuses to boot on missing config rather than failing on the first
  real request.
