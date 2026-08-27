# api.acemusic.ai, as measured

Everything here was established by calling the live endpoint on 27 August 2026,
not read off a documentation page. It is written down because most of it
contradicts the obvious way to use the API, and two of the findings cost real
time to discover.

The endpoint is ACE Music's free hosted [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5)
(MIT, ~12.4k stars, `acemusic.ai` is the project's own homepage). Free keys come
from `acemusic.ai/playground/api-key`.

```
GET /v1/models
{ "data": [ { "id": "acemusic/acestep-v1.5-turbo",
              "pricing": { "prompt": "0", "completion": "0", "request": "0" } } ] }
```

---

## 1. `thinking: false` is what makes full-length songs possible

The most important finding, and the least obvious. `thinking` runs ACE's 5Hz
planning LM before the diffusion step. Upstream's own `config.example.json`
defaults it to **true**, which on the hosted endpoint is the difference between
working and not working.

| `thinking` | requested | result |
|---|---|---|
| `false` | 120s | **200 in 19s** |
| `false` | 180s | **200 in 21s** |
| `false` | 240s | **200 in 50s** |
| `true` | 30s | 200 in ~33s, twice — then **504 six times running** |
| `true` | 120s | **504 at 60s** |

The intuition that a longer song takes longer is roughly wrong: a three-minute
track costs about two seconds more than a two-minute one. The planning LM is what
consumes the budget.

Consequence: the free tier can produce a full three-minute song reliably, in about
twenty seconds. It just cannot do it with the settings the docs suggest.

## 2. A hard 60-second wall

Cloudflare fronts the endpoint and severs the connection at exactly 60 seconds,
returning a 16-byte, **non-JSON** body:

```
error code: 504
```

Parse failures here are a real bug source — `res.json()` throws on the response
you most need to handle.

Because generation is synchronous, a request that exceeds 60s cannot be recovered:
there is no task id left behind to poll. `stream: true` does not help; a streamed
request died at the same 60s mark. This is the entire reason the service is built
around a queue.

## 3. Completion mode only

Every tutorial and the upstream API docs describe an async flow — `/release_task`
then `/query_result` then `/v1/audio`. **The hosted endpoint does not expose it.**

| path | result |
|---|---|
| `POST /v1/chat/completions` | works |
| `GET /v1/models` | works (intermittently slow: seen timing out at 25s, then instant) |
| `GET /health` | works, ~100ms |
| `POST /release_task` | **404** |
| `POST /v1/release_task` | **404** |
| `POST /query_result` | **404** |
| `GET /v1/stats`, `/docs`, `/openapi.json` | **404** |

This was reported in [#1186](https://github.com/ace-step/ACE-Step-1.5/issues/1186)
in May and is still true in August.

## 4. No duration without the XML tags

`audio_config.duration` is **silently discarded** unless the message content wraps
the style and lyrics in explicit tags:

```json
{
  "messages": [{
    "role": "user",
    "content": "<prompt>gentle acoustic ballad…</prompt><lyrics>[Verse 1]\n…</lyrics>"
  }],
  "audio_config": { "duration": 180, "format": "mp3", "vocal_language": "en" }
}
```

Plain text trips a heuristic that routes the request into sample mode, where an LM
overwrites the metadata and forces a default of roughly three minutes
([#1215](https://github.com/ace-step/ACE-Step-1.5/issues/1215)). With the tags
present, duration is honoured *exactly* — a request for 180s returned 2,880,813
bytes measuring 180.0s.

## 5. Never `use_format: true`

It hands your lyrics to the LM to "enhance". Given:

> he slept in the laundry basket and never in his bed. thirteen years. we miss him.

it returned:

```
[Verse 1]
He slept in the laundry basket and never in his bed. Twenty years. We miss him.Thirty.

[Verse 2]
PDm, 12:28, 12:28, 12:28
```

It invented a number, contradicted the input, appended a stray "Thirty.", and
filled a verse with timestamps. The *caption* it wrote was genuinely good. The
lyrics are unusable. Lyrics must arrive finished and be passed through untouched.

## 6. A browser cannot call it

No `Access-Control-Allow-Origin` on any response, and the `OPTIONS` preflight does
not answer at all — it times out. Reported in
[#1237](https://github.com/ace-step/ACE-Step-1.5/issues/1237) in June, closed by a
stale bot, never fixed.

A server-side proxy is therefore mandatory, not a design preference.

## 7. Output is 128kbps mp3

48kHz, CBR 128kbps, ~16KB per second of audio. Not configurable on the hosted
tier. A known complaint upstream ([#1117](https://github.com/ace-step/ACE-Step-1.5/issues/1117),
[#1261](https://github.com/ace-step/ACE-Step-1.5/issues/1261)) where 320kbps and
wav were added — for local use.

Fine for auditioning. Thin for something a customer pays for and keeps.

## 8. Reliability: assume failure is normal

The clearest data point: the *identical* valid request that succeeded twice at
07:04 and 07:05 then returned 504 six consecutive times over the following eight
minutes. Nothing changed but load. `/health` returned 200 throughout — it never
touches the GPU, so it is useless as a readiness signal.

An observed sequence, one request each:

```
30s  200 in 32s   ✓
30s  200 in 34s   ✓
150s 504 in 60s   ✗
60s  504 in 60s   ✗
90s  504 in 60s   ✗
30s  504 in 60s   ✗   ← the request that worked twice
45s  504 in 60s   ✗
40s  504 in 60s   ✗
35s  504 in 60s   ✗
```

Retry with jittered backoff, serialise requests, and never make a human wait on a
single call.

---

## The business problem nobody upstream answered

[#1238](https://github.com/ace-step/ACE-Step-1.5/issues/1238) asked directly
whether music generated through acemusic.ai can be monetised on YouTube and
distributed through Spotify or DistroKid. **It received no reply and was closed by
a stale bot after 28 days.**

The nearest thing to an answer is [#1182](https://github.com/ace-step/ACE-Step-1.5/issues/1182),
where a maintainer replied "Yes" — but that question was about using outputs as
*training data*, and about the MIT licence covering code and weights.

The distinction that matters for a business charging money:

- **Self-hosted output** — you are running MIT-licensed weights on your own
  hardware. The rights are unambiguous.
- **Hosted output** — governed by acemusic.ai's terms as a service, which have
  never been clarified in public despite being asked.

A maintainer has also acknowledged that the hosted product path may not run the
same code as the local one ([#1294](https://github.com/ace-step/ACE-Step-1.5/issues/1294)),
so hosted is second-class in more than one sense.

**Read acemusic.ai's terms, or self-host, before taking money for a song.** This
is the strongest single argument for flipping `MUSIC_PROVIDER=selfhosted`, and it
has nothing to do with quality or uptime.

## Security notes for when you self-host

Two open upstream issues worth knowing before exposing an ACE-Step server:

- [#1131](https://github.com/ace-step/ACE-Step-1.5/issues/1131) — authentication
  is **fail-open** when `ACESTEP_API_KEY` is unset. Unset means no auth, not no
  access.
- [#1130](https://github.com/ace-step/ACE-Step-1.5/issues/1130) — the API accepts
  the key in the request body as `ai_token`, where it leaks into logs and
  intermediaries. Use the `Authorization` header. `src/ace/selfhosted.ts` only
  ever does.
