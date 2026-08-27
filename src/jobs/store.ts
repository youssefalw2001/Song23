/**
 * Where jobs live.
 *
 * One directory per job, holding the record and every take of the audio. A
 * database would be defensible; a directory is better here, because the thing
 * being stored is a small number of large files plus a little JSON, and because
 * when something goes wrong at 2am you want to be able to look at it with `ls`
 * and play it with anything.
 *
 *   data/jobs/<id>/job.json
 *   data/jobs/<id>/take-1.mp3
 *   data/jobs/<id>/take-2.mp3
 *
 * Everything in here is customer data — their words about their dead pet, their
 * email. `data/` is gitignored, and it should be backed up like the liability it
 * is, not like a cache.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.ts";
import { log } from "../log.ts";
import type { Job, Answers, SongBrief, AudioFormat, JobAttempt } from "../types.ts";

const jobsDir = () => join(config.dataDir, "jobs");
const jobDir = (id: string) => join(jobsDir(), id);
const recordPath = (id: string) => join(jobDir(id), "job.json");

export function initStore(): void {
  mkdirSync(jobsDir(), { recursive: true });
  log.info("job store ready", { dir: jobsDir() });
}

/**
 * Short, unambiguous, safe in a URL and a filename.
 *
 * Not a UUID because these get pasted into chat messages and read aloud, and
 * not sequential because job ids end up in URLs the operator shares.
 */
function newId(): string {
  return randomBytes(6).toString("base64url");
}

/**
 * Write via a temp file and rename.
 *
 * A crash halfway through writing job.json would otherwise leave a truncated
 * record and lose a customer's answers. Rename is atomic on the same filesystem;
 * this is cheap insurance for data we cannot reconstruct.
 */
function writeRecord(job: Job): void {
  const dir = jobDir(job.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `job.json.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(job, null, 2), "utf8");
  renameSync(tmp, recordPath(job.id));
}

export function createJob(answers: Answers, brief: SongBrief): Job {
  const now = new Date().toISOString();
  const job: Job = {
    id: newId(),
    // Not "queued" — nothing is queued until someone presses generate.
    status: "draft",
    createdAt: now,
    updatedAt: now,
    answers,
    brief,
    attempts: [],
    take: 0,
  };
  writeRecord(job);
  log.info("job created", { id: job.id, pet: answers.petName, duration: brief.durationSeconds });
  return job;
}

export function getJob(id: string): Job | null {
  // Defend the filesystem from the URL. Ids are base64url, nothing else.
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return null;
  const path = recordPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Job;
  } catch (err) {
    log.error("job record unreadable", { id, error: (err as Error).message });
    return null;
  }
}

export function saveJob(job: Job): Job {
  job.updatedAt = new Date().toISOString();
  writeRecord(job);
  return job;
}

export function listJobs(limit = 100): Job[] {
  if (!existsSync(jobsDir())) return [];
  const jobs: Job[] = [];
  for (const entry of readdirSync(jobsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const job = getJob(entry.name);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function recordAttempt(job: Job, attempt: JobAttempt): void {
  job.attempts.push(attempt);
  saveJob(job);
}

/** Filename for a take. Takes are kept, never overwritten — see writeTake. */
export function takeFilename(take: number, format: AudioFormat): string {
  return `take-${take}.${format}`;
}

/**
 * Save a take alongside the others.
 *
 * Nothing is ever overwritten. Regenerating is how the operator searches for the
 * right song, and take 3 being better than take 5 is common; deleting takes would
 * make that search lossy for no benefit. A few megabytes each is not a problem
 * worth solving.
 */
export function writeTake(
  job: Job,
  audio: Buffer,
  format: AudioFormat,
): { filename: string; path: string } {
  const filename = takeFilename(job.take, format);
  const path = join(jobDir(job.id), filename);
  writeFileSync(path, audio);
  return { filename, path };
}

export function readTake(id: string, filename: string): Buffer | null {
  if (!/^take-\d+\.(mp3|wav|flac|opus|aac)$/.test(filename)) return null;
  const path = join(jobDir(id), filename);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

/** Every take on disk, newest first. The operator wants to compare them. */
export function listTakes(id: string): string[] {
  const dir = jobDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^take-\d+\.(mp3|wav|flac|opus|aac)$/.test(f))
    .sort((a, b) => {
      const na = Number.parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
      const nb = Number.parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
      return nb - na;
    });
}

/**
 * Jobs interrupted mid-generation by a restart.
 *
 * A synchronous provider call cannot be resumed — there is no task id to pick up
 * — so anything left "generating" when the process died is stranded. Requeueing
 * them on boot is right: the customer's answers and brief are intact, and the
 * only thing lost is one attempt.
 */
export function requeueStranded(): number {
  let count = 0;
  for (const job of listJobs(1000)) {
    if (job.status !== "generating") continue;
    job.status = "queued";
    job.attempts.push({
      startedAt: job.updatedAt,
      endedAt: new Date().toISOString(),
      ok: false,
      status: 0,
      ms: 0,
      error: "the service restarted mid-generation; requeued",
    });
    saveJob(job);
    count += 1;
  }
  if (count) log.warn("requeued jobs stranded by a restart", { count });
  return count;
}
