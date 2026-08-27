/**
 * ACE Music's free hosted ACE-Step 1.5 — https://api.acemusic.ai
 *
 * Everything unusual in this file is a workaround for something measured against
 * the live endpoint. The findings, so nobody has to rediscover them:
 *
 * 1. COMPLETION MODE ONLY. The upstream project documents a native async API
 *    (`/release_task` + `/query_result`), and every tutorial uses it. The hosted
 *    endpoint does not expose it — all three paths return 404. The only way in is
 *    `POST /v1/chat/completions`, which is synchronous and hands back the audio
 *    inline as a base64 data URI.
 *
 * 2. A 60-SECOND WALL. Cloudflare sits in front and cuts the connection at
 *    exactly 60s with a 16-byte, non-JSON `error code: 504`. Because generation
 *    is synchronous, a request that takes longer than 60s cannot succeed — there
 *    is no task id left behind to poll for. This is why the caller is a queue.
 *
 * 3. `thinking` IS THE PROBLEM, NOT DURATION. This is the counter-intuitive one.
 *    ACE's own config.example.json defaults `thinking: true`, which runs a 5Hz
 *    planning LM before the diffusion step. Measured:
 *
 *        thinking=false  duration=120  ->  200 in 19s
 *        thinking=false  duration=180  ->  200 in 21s
 *        thinking=false  duration=240  ->  200 in 50s
 *        thinking=true   duration=120  ->  504 at 60s
 *        thinking=true   duration=30   ->  200 in ~33s, then 504 six times running
 *
 *    So duration is nearly free and the LM is what blows the budget. Full-length
 *    songs are comfortably achievable here; the upstream default is what makes
 *    them look impossible.
 *
 * 4. NO DURATION WITHOUT XML TAGS. `audio_config.duration` is silently discarded
 *    unless the message content is wrapped in explicit <prompt>/<lyrics> tags.
 *    Plain text trips a heuristic that routes the request into sample mode, where
 *    an LM overwrites the metadata and forces a default ~3 minutes
 *    (ace-step/ACE-Step-1.5#1215). We always send the tags.
 *
 * 5. NEVER `use_format: true`. It hands the lyrics to the LM to "enhance". Given
 *    "he slept in the laundry basket and never in his bed. thirteen years." it
 *    returned "Twenty years. We miss him.Thirty." and a verse reading
 *    "PDm, 12:28, 12:28, 12:28". It invents facts and emits garbage. The caption
 *    it writes is genuinely good; the lyrics are unusable. Lyrics arrive here
 *    finished, and are passed through untouched.
 *
 * 6. OUTPUT IS 128kbps MP3. Not configurable on the hosted tier, and a known
 *    complaint upstream (#1117, #1261). Fine for the operator to audition, thin
 *    for a paid deliverable. Self-hosting is how you get wav.
 */

import { config } from "../config.ts";
import { log } from "../log.ts";
import { probeAudio, looksLikeAudio } from "../audio.ts";
import { ProviderError, isRetryableStatus, type MusicProvider } from "./provider.ts";
import type { GenerateRequest, GeneratedTrack, ProviderHealth } from "../types.ts";

/** Fallback when /v1/models can't be reached. Confirmed live id. */
const DEFAULT_MODEL = "acemusic/acestep-v1.5-turbo";

/**
 * Give up at 70s.
 *
 * The gateway kills the connection at 60. Waiting longer only delays the retry,
 * and a socket held open against an overloaded pool is not helping anyone.
 */
const REQUEST_TIMEOUT_MS = 70_000;

type CompletionResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      audio?: Array<{ type?: string; audio_url?: { url?: string } }>;
      audio_codes?: string;
    };
  }>;
};

export class AceMusicProvider implements MusicProvider {
  readonly name = "acemusic";

  #modelId: string | null = null;

  /**
   * ACE takes style and lyrics as two XML-tagged fields inside one chat message.
   * Building it in one place keeps the tag contract (see note 4) in one place.
   */
  #buildContent(req: GenerateRequest): string {
    const caption = req.caption.trim();
    const lyrics = req.lyrics.trim();

    if (!caption) {
      throw new ProviderError({
        message: "caption is empty — ACE weights it more heavily than any other input",
        status: 0,
        retryable: false,
      });
    }
    if (!lyrics) {
      throw new ProviderError({
        message: 'lyrics are empty — use "[inst]" for a deliberate instrumental',
        status: 0,
        retryable: false,
      });
    }

    // The tags are not optional. Without them duration is discarded (note 4).
    return `<prompt>${caption}</prompt><lyrics>${lyrics}</lyrics>`;
  }

  #buildPayload(req: GenerateRequest, modelId: string): Record<string, unknown> {
    const audioConfig: Record<string, unknown> = {
      duration: req.durationSeconds,
      format: req.format,
      vocal_language: req.vocalLanguage,
    };
    if (req.bpm) audioConfig.bpm = req.bpm;
    if (req.keyScale) audioConfig.key_scale = req.keyScale;
    if (req.timeSignature) audioConfig.time_signature = req.timeSignature;
    // Best-effort: documented for the native API, undocumented here. Harmless
    // if ignored, and worth sending so a good take can be re-derived.
    if (req.seed !== undefined) audioConfig.seed = req.seed;

    return {
      model: modelId,
      messages: [{ role: "user", content: this.#buildContent(req) }],
      stream: false,
      // Streaming doesn't help: a stream:true request still died at the 60s wall.
      thinking: config.acemusic.thinking,
      use_format: false, // see note 5. Not a knob.
      audio_config: audioConfig,
    };
  }

  async #resolveModel(): Promise<string> {
    if (this.#modelId) return this.#modelId;
    try {
      const res = await this.#fetch("/v1/models", { method: "GET" }, 20_000);
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const id = body.data?.[0]?.id;
      this.#modelId = id ?? DEFAULT_MODEL;
    } catch {
      // Not fatal — the id has been stable and we have a known-good fallback.
      this.#modelId = DEFAULT_MODEL;
    }
    log.debug("acemusic model resolved", { model: this.#modelId });
    return this.#modelId;
  }

  async #fetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${config.acemusic.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.acemusic.apiKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GeneratedTrack> {
    const modelId = await this.#resolveModel();
    const payload = this.#buildPayload(req, modelId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(`${config.acemusic.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.acemusic.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      throw new ProviderError({
        message: aborted
          ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s (the gateway cuts at 60s)`
          : `transport failure: ${(err as Error)?.message ?? String(err)}`,
        status: 0,
        retryable: true, // both cases are "the pool is busy", not "the request is wrong"
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }

    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      // The 504 body is `error code: 504` — plain text, not JSON. Read as text.
      const body = (await res.text().catch(() => "")).slice(0, 400);
      throw new ProviderError({
        message:
          res.status === 504
            ? `gateway timeout after ${Math.round(elapsedMs / 1000)}s — the free GPU pool is backed up`
            : `HTTP ${res.status} from acemusic.ai`,
        status: res.status,
        retryable: isRetryableStatus(res.status),
        body,
      });
    }

    const raw = await res.text();
    let parsed: CompletionResponse;
    try {
      parsed = JSON.parse(raw) as CompletionResponse;
    } catch {
      throw new ProviderError({
        message: "200 response was not JSON",
        status: 200,
        retryable: true,
        body: raw.slice(0, 400),
      });
    }

    const message = parsed.choices?.[0]?.message;
    const dataUri = message?.audio?.[0]?.audio_url?.url;

    if (!dataUri) {
      // A 200 with no audio usually means the request was quietly rerouted into
      // a text-only path. Not retryable — the payload needs fixing.
      throw new ProviderError({
        message: `200 response carried no audio (content: ${JSON.stringify(
          message?.content ?? null,
        )})`,
        status: 200,
        retryable: false,
        body: raw.slice(0, 400),
      });
    }

    const comma = dataUri.indexOf(",");
    if (comma === -1 || !dataUri.startsWith("data:")) {
      throw new ProviderError({
        message: "audio_url was not a data URI",
        status: 200,
        retryable: false,
        body: dataUri.slice(0, 120),
      });
    }

    const audio = Buffer.from(dataUri.slice(comma + 1), "base64");
    const contentType = dataUri.slice(5, dataUri.indexOf(";")) || "audio/mpeg";

    const sanity = looksLikeAudio(audio);
    if (!sanity.ok) {
      // A well-formed file of silence is worse than an error, so treat it as one.
      throw new ProviderError({
        message: `returned audio failed the sanity check (${sanity.detail})`,
        status: 200,
        retryable: true,
        body: "",
      });
    }

    const probe = probeAudio(audio);

    log.info("acemusic generation succeeded", {
      ms: elapsedMs,
      requested: req.durationSeconds,
      measured: probe.approxDurationSeconds,
      bytes: audio.byteLength,
      container: probe.detail,
      thinking: config.acemusic.thinking,
    });

    // Worth knowing about rather than silently shipping: see note 4.
    if (
      req.durationSeconds &&
      Math.abs(probe.approxDurationSeconds - req.durationSeconds) > req.durationSeconds * 0.15
    ) {
      log.warn("returned duration does not match the request", {
        requested: req.durationSeconds,
        measured: probe.approxDurationSeconds,
        hint: "check the <prompt>/<lyrics> tags are intact (ACE-Step-1.5#1215)",
      });
    }

    return {
      audio,
      contentType,
      format: req.format,
      bytes: audio.byteLength,
      approxDurationSeconds: probe.approxDurationSeconds,
      provider: this.name,
      providerId: parsed.id ?? null,
      ...(message?.audio_codes ? { audioCodes: message.audio_codes } : {}),
      providerNotes: `${probe.detail}; ${sanity.detail}; ${Math.round(elapsedMs / 1000)}s`,
    };
  }

  /**
   * Reachability, in two steps, because the obvious single check is unreliable.
   *
   * `/health` is a trivial endpoint that answers in ~100ms regardless of load.
   * `/v1/models` goes further back into the application and is genuinely flaky —
   * observed timing out at 25s and then answering in under a second on the retry.
   * So reachability comes from /health, and the model list is best-effort on top.
   *
   * Neither proves a song can be generated right now. /health returned 200
   * throughout a run of eight consecutive generation failures, which is exactly
   * the trap this wording is trying to avoid walking the operator into.
   */
  async health(): Promise<ProviderHealth> {
    try {
      const res = await this.#fetch("/health", { method: "GET" }, 12_000);
      if (!res.ok) {
        return { ok: false, provider: this.name, detail: `/health returned HTTP ${res.status}` };
      }
    } catch (err) {
      return {
        ok: false,
        provider: this.name,
        detail: `unreachable: ${(err as Error)?.message ?? String(err)}`,
      };
    }

    let models: string[] = [];
    let modelNote = "model list unavailable (this endpoint is intermittently slow)";
    try {
      const res = await this.#fetch("/v1/models", { method: "GET" }, 30_000);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          provider: this.name,
          detail: `host is up but rejected the key (HTTP ${res.status}) — check ACE_API_KEY`,
        };
      }
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        models = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
        modelNote = "authenticated";
      }
    } catch {
      /* best-effort */
    }

    return {
      ok: true,
      provider: this.name,
      detail: `host reachable, ${modelNote}. Says nothing about whether the GPU pool is free — /health stays 200 while every generation 504s.`,
      models,
    };
  }
}
