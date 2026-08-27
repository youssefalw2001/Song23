/**
 * Configuration, read once at boot and validated loudly.
 *
 * A service that generates deliverables for paying customers should refuse to
 * start rather than discover a missing key on the first real request.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AudioFormat } from "./types.ts";

/** Minimal .env reader. Not worth a dependency. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment wins over the file, so a deploy can override.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(resolve(process.cwd(), ".env"));

function str(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function bool(key: string, fallback: boolean): boolean {
  const v = str(key).toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

function int(key: string, fallback: number): number {
  const v = Number.parseInt(str(key), 10);
  return Number.isFinite(v) ? v : fallback;
}

export type ProviderName = "acemusic" | "selfhosted";

const providerRaw = str("MUSIC_PROVIDER", "acemusic");
if (providerRaw !== "acemusic" && providerRaw !== "selfhosted") {
  throw new Error(
    `MUSIC_PROVIDER must be "acemusic" or "selfhosted", got "${providerRaw}"`,
  );
}

export const config = {
  provider: providerRaw as ProviderName,

  port: int("PORT", 8787),
  dataDir: resolve(process.cwd(), str("DATA_DIR", "./data")),

  operatorToken: str("OPERATOR_TOKEN"),
  allowedOrigins: str("ALLOWED_ORIGINS")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  acemusic: {
    baseUrl: str("ACE_BASE_URL", "https://api.acemusic.ai").replace(/\/+$/, ""),
    apiKey: str("ACE_API_KEY"),
    /**
     * Defaults to false on purpose, against the upstream default.
     *
     * ACE's own config.example.json ships `thinking: true`. On the hosted
     * endpoint that is the worst possible setting: measured against
     * api.acemusic.ai, thinking=true returned 504 at the 60s gateway timeout
     * even for a 30-second request, while thinking=false produced a full
     * 180-second song in 21 seconds. See docs/ACE-MUSIC-API.md.
     */
    thinking: bool("ACE_THINKING", false),
  },

  selfhosted: {
    baseUrl: str("SELFHOSTED_BASE_URL", "http://127.0.0.1:8001").replace(/\/+$/, ""),
    apiKey: str("SELFHOSTED_API_KEY"),
    model: str("SELFHOSTED_MODEL"),
    audioFormat: (str("SELFHOSTED_AUDIO_FORMAT", "wav") || "wav") as AudioFormat,
  },
} as const;

/** Fatal misconfiguration, collected so you fix all of it in one pass. */
export function validateConfig(): string[] {
  const problems: string[] = [];

  if (!config.operatorToken) {
    problems.push(
      "OPERATOR_TOKEN is not set. The service would accept song requests from anyone.",
    );
  } else if (config.operatorToken.length < 24) {
    problems.push("OPERATOR_TOKEN is shorter than 24 characters. Generate a real one.");
  }

  if (config.provider === "acemusic" && !config.acemusic.apiKey) {
    problems.push(
      "MUSIC_PROVIDER=acemusic but ACE_API_KEY is empty. Get a free key at https://acemusic.ai/playground/api-key",
    );
  }

  if (config.allowedOrigins.length === 0) {
    problems.push(
      "ALLOWED_ORIGINS is empty. The studio page runs in a browser and will be blocked by CORS.",
    );
  }

  return problems;
}

/** Warnings worth printing but not worth refusing to boot over. */
export function configWarnings(): string[] {
  const warnings: string[] = [];

  if (config.provider === "acemusic" && config.acemusic.thinking) {
    warnings.push(
      "ACE_THINKING=true with the hosted provider. Measured behaviour is a 504 at " +
        "the 60s gateway timeout. Expect most jobs to fail after exhausting retries.",
    );
  }

  if (config.provider === "acemusic") {
    warnings.push(
      "Provider is the free hosted endpoint: 128kbps mp3, no uptime guarantee, and " +
        "commercial rights to hosted output have never been confirmed upstream " +
        "(ace-step/ACE-Step-1.5#1238 went unanswered). Switch to selfhosted before charging.",
    );
  }

  return warnings;
}
