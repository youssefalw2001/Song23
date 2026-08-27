/**
 * The seam between "what a song is" and "who generates it".
 *
 * There are two implementations: the free hosted endpoint and a self-hosted
 * ACE-Step server. They are genuinely different protocols — one is a synchronous
 * OpenAI-style chat completion that returns base64 audio, the other is an async
 * submit-and-poll queue — and the differences are not cosmetic. Keeping them
 * behind one interface is what makes moving off the free tier a config change
 * rather than a rewrite.
 */

import type { GenerateRequest, GeneratedTrack, ProviderHealth } from "../types.ts";

export interface MusicProvider {
  readonly name: string;
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<GeneratedTrack>;
  health(): Promise<ProviderHealth>;
}

/**
 * A provider failure that carries whether trying again could plausibly work.
 *
 * This distinction is the whole reason the job queue exists. A 504 from an
 * overloaded free GPU pool is worth retrying; a 400 because the lyrics were
 * empty is not, and retrying it just burns minutes before the operator finds out.
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: string;

  constructor(opts: { message: string; status: number; retryable: boolean; body?: string }) {
    super(opts.message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.body = opts.body ?? "";
  }
}

/**
 * Statuses worth another go.
 *
 * 504 is the one that matters in practice — it's what Cloudflare returns when
 * the free GPU pool is backed up past the 60s edge timeout. 429 and the 5xx
 * family are the usual suspects. 408 shows up on slow upstreams.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters more than usual here: the failure mode is a shared queue that's
 * already oversubscribed, so a fleet of clients retrying on identical schedules
 * is exactly how you keep it oversubscribed.
 */
export function backoffMs(attempt: number, baseMs = 4_000, capMs = 90_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
