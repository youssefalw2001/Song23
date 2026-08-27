/**
 * Your own ACE-Step 1.5 server — the escape hatch.
 *
 * This is where the business ends up, and it exists now so that getting there is
 * a one-line config change instead of a project. Same model as the free tier;
 * everything around it is better:
 *
 *   - Native async API (`/release_task` -> `/query_result` -> `/v1/audio`), so
 *     there is no 60-second gateway wall. Submit, poll, collect. A generation can
 *     take as long as it takes.
 *   - `thinking: true` becomes usable, because nothing is timing you out. That's
 *     the 5Hz planning LM, and it's the quality setting the free tier can't run.
 *   - wav or flac instead of 128kbps mp3. For something a customer pays for and
 *     keeps, this is the difference between a deliverable and a preview.
 *   - The MIT licence covers the weights and the code you're running, so the
 *     rights to the output are unambiguous. Nobody upstream ever answered whether
 *     hosted output can be sold (ace-step/ACE-Step-1.5#1238 was opened, ignored,
 *     and closed by a stale bot). For a business that charges money, that silence
 *     is the strongest argument in this file.
 *
 * Two things to get right when you stand the server up, both from open upstream
 * security issues:
 *   - Set ACESTEP_API_KEY. Auth is fail-open when it's unset (#1131) — an
 *     unset key means no auth, not no access.
 *   - Authenticate with the Authorization header, never the `ai_token` body
 *     field, which leaks through logs and intermediaries (#1130). This adapter
 *     only ever uses the header.
 *
 * Untested against a live server — there isn't one yet. The protocol is
 * implemented from the upstream API docs and is deliberately verbose about what
 * it expects, so the first real run fails loudly and specifically.
 */

import { config } from "../config.ts";
import { log } from "../log.ts";
import { probeAudio, looksLikeAudio } from "../audio.ts";
import {
  ProviderError,
  isRetryableStatus,
  sleep,
  type MusicProvider,
} from "./provider.ts";
import type { GenerateRequest, GeneratedTrack, ProviderHealth } from "../types.ts";

/** Upstream wraps every response in this envelope. */
type Envelope<T> = { data?: T; code?: number; error?: string | null; timestamp?: number };

/** 0 = queued or running, 1 = succeeded, 2 = failed. */
type TaskStatus = 0 | 1 | 2;

type ReleaseTaskData = { task_id?: string; status?: string; queue_position?: number };
type QueryResultData = Array<{ task_id?: string; status?: TaskStatus; result?: string }>;

/** One entry of the JSON *string* inside `result`. Yes, a string. */
type TaskResultEntry = {
  file?: string;
  status?: number;
  seed_value?: string;
  metas?: { bpm?: number; duration?: number; keyscale?: string; timesignature?: string };
  generation_info?: string;
  dit_model?: string;
  lm_model?: string;
};

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 20 * 60_000;

export class SelfHostedProvider implements MusicProvider {
  readonly name = "selfhosted";

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Header only. Never the ai_token body field (#1130).
    if (config.selfhosted.apiKey) {
      headers.Authorization = `Bearer ${config.selfhosted.apiKey}`;
    }
    return headers;
  }

  async #post<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${config.selfhosted.baseUrl}${path}`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError({
        message: `cannot reach ${config.selfhosted.baseUrl}${path}: ${
          (err as Error)?.message ?? String(err)
        }`,
        status: 0,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      throw new ProviderError({
        message: `HTTP ${res.status} from ${path}${
          res.status === 401 ? " — check SELFHOSTED_API_KEY" : ""
        }${res.status === 429 ? " — the server's queue is full" : ""}`,
        status: res.status,
        retryable: isRetryableStatus(res.status),
        body: text,
      });
    }

    const envelope = (await res.json()) as Envelope<T>;
    if (envelope.error) {
      throw new ProviderError({
        message: `${path} reported: ${envelope.error}`,
        status: envelope.code ?? 500,
        retryable: false,
      });
    }
    if (envelope.data === undefined) {
      throw new ProviderError({
        message: `${path} returned an envelope with no data`,
        status: 500,
        retryable: true,
      });
    }
    return envelope.data;
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GeneratedTrack> {
    const format = config.selfhosted.audioFormat || req.format;

    const payload: Record<string, unknown> = {
      prompt: req.caption,
      // Pass the lyrics whole. Upstream is explicit that truncating them
      // produces incomplete songs, and there is no reason to trim.
      lyrics: req.lyrics,
      // Affordable here, unlike on the hosted tier: nothing is timing us out.
      thinking: true,
      // The LM must not rewrite finished lyrics. Same reasoning as the hosted
      // adapter — it invents facts and emits garbage.
      use_format: false,
      use_cot_caption: false,
      audio_duration: req.durationSeconds,
      audio_format: format,
      vocal_language: req.vocalLanguage,
      batch_size: 1,
    };
    if (req.bpm) payload.bpm = req.bpm;
    if (req.keyScale) payload.key_scale = req.keyScale;
    if (req.timeSignature) payload.time_signature = req.timeSignature;
    if (config.selfhosted.model) payload.model = config.selfhosted.model;
    if (req.seed !== undefined) {
      payload.seed = req.seed;
      payload.use_random_seed = false;
    }

    const submitted = await this.#post<ReleaseTaskData>("/release_task", payload);
    const taskId = submitted.task_id;
    if (!taskId) {
      throw new ProviderError({
        message: "/release_task returned no task_id",
        status: 500,
        retryable: true,
      });
    }

    log.info("selfhosted task submitted", {
      taskId,
      queuePosition: submitted.queue_position,
      duration: req.durationSeconds,
    });

    const entry = await this.#poll(taskId, signal);

    if (!entry.file) {
      throw new ProviderError({
        message: `task ${taskId} succeeded but returned no file path`,
        status: 500,
        retryable: false,
      });
    }

    const audio = await this.#download(entry.file, signal);
    const sanity = looksLikeAudio(audio);
    if (!sanity.ok) {
      throw new ProviderError({
        message: `returned audio failed the sanity check (${sanity.detail})`,
        status: 200,
        retryable: true,
      });
    }
    const probe = probeAudio(audio);

    log.info("selfhosted generation succeeded", {
      taskId,
      requested: req.durationSeconds,
      measured: probe.approxDurationSeconds,
      bytes: audio.byteLength,
      ditModel: entry.dit_model,
    });

    return {
      audio,
      contentType: format === "wav" ? "audio/wav" : format === "flac" ? "audio/flac" : "audio/mpeg",
      format,
      bytes: audio.byteLength,
      approxDurationSeconds: probe.approxDurationSeconds,
      provider: this.name,
      providerId: taskId,
      providerNotes: [
        probe.detail,
        sanity.detail,
        entry.dit_model ? `dit=${entry.dit_model}` : "",
        entry.seed_value ? `seed=${entry.seed_value}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    };
  }

  async #poll(taskId: string, signal?: AbortSignal): Promise<TaskResultEntry> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ProviderError({ message: "aborted", status: 0, retryable: false });
      await sleep(POLL_INTERVAL_MS, signal);

      const rows = await this.#post<QueryResultData>("/query_result", {
        task_id_list: [taskId],
      });
      const row = rows.find((r) => r.task_id === taskId) ?? rows[0];
      if (!row) continue;

      if (row.status === 2) {
        throw new ProviderError({
          message: `task ${taskId} failed on the server`,
          status: 500,
          retryable: true,
          body: (row.result ?? "").slice(0, 400),
        });
      }

      if (row.status === 1) {
        // `result` is a JSON string, not an object. Parsing it is not optional.
        let entries: TaskResultEntry[];
        try {
          entries = JSON.parse(row.result ?? "[]") as TaskResultEntry[];
        } catch {
          throw new ProviderError({
            message: `task ${taskId} succeeded but result was not parseable JSON`,
            status: 500,
            retryable: false,
            body: (row.result ?? "").slice(0, 400),
          });
        }
        const entry = entries[0];
        if (!entry) {
          throw new ProviderError({
            message: `task ${taskId} succeeded with an empty result array`,
            status: 500,
            retryable: false,
          });
        }
        return entry;
      }
      // status 0: still queued or running. Keep going.
    }

    throw new ProviderError({
      message: `task ${taskId} did not finish within ${POLL_TIMEOUT_MS / 60_000} minutes`,
      status: 0,
      retryable: false,
    });
  }

  async #download(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    // `file` arrives as a ready-made relative URL like "/v1/audio?path=...".
    // Only build the endpoint ourselves if it's a bare filesystem path.
    const url = filePath.startsWith("/v1/audio")
      ? `${config.selfhosted.baseUrl}${filePath}`
      : `${config.selfhosted.baseUrl}/v1/audio?path=${encodeURIComponent(filePath)}`;

    const res = await fetch(url, {
      headers: config.selfhosted.apiKey
        ? { Authorization: `Bearer ${config.selfhosted.apiKey}` }
        : {},
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new ProviderError({
        message: `downloading audio returned HTTP ${res.status}`,
        status: res.status,
        retryable: isRetryableStatus(res.status),
      });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async health(): Promise<ProviderHealth> {
    try {
      const res = await fetch(`${config.selfhosted.baseUrl}/health`, {
        signal: AbortSignal.timeout(10_000),
        headers: this.#headers(),
      });
      if (!res.ok) {
        return { ok: false, provider: this.name, detail: `/health returned HTTP ${res.status}` };
      }

      // Unlike the hosted tier, this server will tell us how loaded it is.
      let detail = "reachable";
      try {
        const stats = await fetch(`${config.selfhosted.baseUrl}/v1/stats`, {
          signal: AbortSignal.timeout(10_000),
          headers: this.#headers(),
        });
        if (stats.ok) {
          const body = (await stats.json()) as Envelope<{
            queue_size?: number;
            avg_job_seconds?: number;
          }>;
          detail = `reachable, queue=${body.data?.queue_size ?? "?"}, avg_job=${
            body.data?.avg_job_seconds ?? "?"
          }s`;
        }
      } catch {
        /* stats are a nicety */
      }

      let models: string[] = [];
      try {
        const res2 = await fetch(`${config.selfhosted.baseUrl}/v1/models`, {
          signal: AbortSignal.timeout(10_000),
          headers: this.#headers(),
        });
        if (res2.ok) {
          const body = (await res2.json()) as Envelope<{ models?: Array<{ name?: string }> }>;
          models = (body.data?.models ?? [])
            .map((m) => m.name)
            .filter((n): n is string => !!n);
        }
      } catch {
        /* optional */
      }

      return { ok: true, provider: this.name, detail, models };
    } catch (err) {
      return {
        ok: false,
        provider: this.name,
        detail: `unreachable at ${config.selfhosted.baseUrl}: ${
          (err as Error)?.message ?? String(err)
        }`,
      };
    }
  }
}
