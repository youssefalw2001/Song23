/**
 * The queue that makes an unreliable synchronous API usable.
 *
 * This is the single most important piece of the service, and it exists because
 * of one measurement: on the free hosted endpoint, the same valid request that
 * succeeded twice then returned 504 six times in a row. The GPU pool is shared
 * and oversubscribed, and Cloudflare cuts the connection at 60 seconds, so
 * failure is not exceptional — it's the normal case that has to be handled.
 *
 * Two rules follow from that:
 *
 *   - Nobody waits on a provider call. The operator posts a job and gets an id
 *     back immediately. If generation takes four attempts over six minutes, the
 *     studio page shows that happening instead of hanging on a request that was
 *     going to fail anyway.
 *
 *   - One generation at a time. Concurrency here would be actively harmful:
 *     the bottleneck is somebody else's saturated queue, and firing three
 *     requests at it converts one slow success into three timeouts. Serialising
 *     is not a simplification, it's the correct policy.
 */

import { getProvider } from "../ace/index.ts";
import { ProviderError, backoffMs, sleep } from "../ace/provider.ts";
import { log } from "../log.ts";
import { config } from "../config.ts";
import { getJob, saveJob, writeTake, requeueStranded, listJobs } from "./store.ts";
import type { Job, AudioFormat } from "../types.ts";

/**
 * Six attempts with jittered backoff spans roughly ten minutes.
 *
 * Long enough to ride out the overload episodes actually observed, short enough
 * that a genuinely broken request surfaces the same morning. Beyond this the
 * right answer is not "try again", it's "look at it".
 */
const MAX_ATTEMPTS = 6;

const OUTPUT_FORMAT: AudioFormat = config.provider === "selfhosted"
  ? config.selfhosted.audioFormat
  : "mp3"; // the hosted tier gives 128kbps mp3 and no choice about it

type QueueState = {
  running: boolean;
  currentJobId: string | null;
  pending: string[];
};

const state: QueueState = { running: false, currentJobId: null, pending: [] };

export function enqueue(jobId: string): void {
  if (state.pending.includes(jobId) || state.currentJobId === jobId) return;
  state.pending.push(jobId);
  log.info("job enqueued", { id: jobId, depth: state.pending.length });
  void pump();
}

export function queueStatus(): { depth: number; current: string | null; running: boolean } {
  return { depth: state.pending.length, current: state.currentJobId, running: state.running };
}

/**
 * Drain the queue, one job at a time.
 *
 * Reentrant-safe via the `running` flag rather than a lock, because there is
 * exactly one event loop and the only await points are inside the job.
 */
async function pump(): Promise<void> {
  if (state.running) return;
  state.running = true;

  try {
    while (state.pending.length > 0) {
      const jobId = state.pending.shift()!;
      state.currentJobId = jobId;
      try {
        await runJob(jobId);
      } catch (err) {
        // runJob owns its own failure handling; reaching here means the store
        // itself misbehaved. Log and keep the queue alive.
        log.error("job crashed outside its handler", {
          id: jobId,
          error: (err as Error)?.message ?? String(err),
        });
      } finally {
        state.currentJobId = null;
      }
    }
  } finally {
    state.running = false;
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) {
    log.error("queued job vanished from the store", { id: jobId });
    return;
  }
  if (job.status === "ready") return;

  const provider = getProvider();

  job.status = "generating";
  job.take += 1;
  saveJob(job);

  const take = job.take;
  log.info("generating", {
    id: job.id,
    take,
    provider: provider.name,
    duration: job.brief.durationSeconds,
    title: job.brief.title,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = new Date();

    try {
      const track = await provider.generate({
        ...job.brief,
        format: OUTPUT_FORMAT,
      });

      const { filename } = writeTake(job, track.audio, track.format);

      const fresh = getJob(job.id) ?? job;
      fresh.status = "ready";
      fresh.take = take;
      fresh.attempts.push({
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        ok: true,
        status: 200,
        ms: Date.now() - startedAt.getTime(),
      });
      fresh.result = {
        audioFile: filename,
        format: track.format,
        bytes: track.bytes,
        approxDurationSeconds: track.approxDurationSeconds,
        provider: track.provider,
        providerId: track.providerId,
        // The site's waveform is drawn from an integer seed rather than the
        // audio, so every take needs a stable one. Derive it from the id and
        // take number: same take, same waveform, forever.
        seed: seedFor(job.id, take),
        finishedAt: new Date().toISOString(),
      };
      delete fresh.error;
      saveJob(fresh);

      log.info("job ready", {
        id: job.id,
        take,
        attempt,
        seconds: track.approxDurationSeconds,
        bytes: track.bytes,
        notes: track.providerNotes,
      });
      return;
    } catch (err) {
      const providerError = err instanceof ProviderError ? err : null;
      const message = (err as Error)?.message ?? String(err);
      const elapsed = Date.now() - startedAt.getTime();

      const fresh = getJob(job.id) ?? job;
      fresh.attempts.push({
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        ok: false,
        status: providerError?.status ?? 0,
        ms: elapsed,
        error: message,
      });
      saveJob(fresh);

      const retryable = providerError?.retryable ?? false;
      const lastAttempt = attempt >= MAX_ATTEMPTS;

      if (!retryable) {
        // A bad brief will fail identically forever. Say so and stop.
        fresh.status = "failed";
        fresh.error = `${message} (not retryable — the request needs changing, not repeating)`;
        saveJob(fresh);
        log.error("job failed permanently", {
          id: job.id,
          take,
          attempt,
          status: providerError?.status,
          error: message,
          body: providerError?.body?.slice(0, 200),
        });
        return;
      }

      if (lastAttempt) {
        fresh.status = "failed";
        fresh.error =
          `${message} — gave up after ${MAX_ATTEMPTS} attempts. ` +
          `The free endpoint is likely overloaded; retry from /studio, or switch ` +
          `MUSIC_PROVIDER to selfhosted.`;
        saveJob(fresh);
        log.error("job failed after exhausting retries", {
          id: job.id,
          take,
          attempts: MAX_ATTEMPTS,
          error: message,
        });
        return;
      }

      const wait = backoffMs(attempt);
      log.warn("attempt failed, backing off", {
        id: job.id,
        take,
        attempt,
        of: MAX_ATTEMPTS,
        status: providerError?.status,
        waitMs: wait,
        error: message,
      });
      await sleep(wait);
    }
  }
}

/**
 * A deterministic waveform seed.
 *
 * The site draws its waveform from `song.seed` with no reference to the audio, so
 * this only has to be stable and well-distributed. Deriving it from the job id
 * and take means the same take always renders the same shape, including after a
 * restart.
 */
function seedFor(jobId: string, take: number): number {
  let hash = 2166136261;
  for (const ch of `${jobId}:${take}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 100_000;
}

/** Pick up anything left queued or stranded by a restart. */
export function resumeOnBoot(): void {
  requeueStranded();
  const queued = listJobs(1000).filter((job: Job) => job.status === "queued");
  for (const job of queued) enqueue(job.id);
  if (queued.length) log.info("resumed queued jobs", { count: queued.length });
}
