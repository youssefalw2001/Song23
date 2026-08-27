/**
 * The HTTP surface.
 *
 * Hand-rolled on node:http rather than a framework, for the same reason the site
 * it serves has three dependencies: there are nine routes, none of them are
 * interesting, and a router is not worth a supply chain.
 *
 * Two things here are not boilerplate and are worth reading:
 *   - `authorise` uses a timing-safe comparison (see the note there).
 *   - `sendAudio` implements Range requests, because the site's player seeks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config, authIsOpen } from "../config.ts";
import { log } from "../log.ts";
import { getProvider } from "../ace/index.ts";
import { studioPage } from "./ui.ts";
import { parseSummary, LABELS } from "../parse-summary.ts";
import { buildBrief, validateBrief } from "../songwriting/brief.ts";
import { createJob, getJob, saveJob, listJobs, readTake, listTakes } from "../jobs/store.ts";
import { enqueue, queueStatus } from "../jobs/queue.ts";
import type { Answers, Job, SongBrief } from "../types.ts";

const MAX_BODY_BYTES = 512 * 1024;

/**
 * The routes, in one list, so that the root page and the 404 can both tell you
 * what exists. A 404 that says only "not found" makes you go and read the source;
 * one that lists the alternatives usually answers the question on its own.
 */
const ROUTES: { method: string; path: string; note: string; auth: boolean }[] = [
  { method: "GET", path: "/", note: "the studio", auth: false },
  { method: "GET", path: "/health", note: "liveness", auth: false },
  { method: "POST", path: "/login", note: "exchange the operator token for a cookie", auth: false },
  { method: "POST", path: "/parse", note: "pasted email -> answers", auth: true },
  { method: "GET", path: "/status", note: "provider, queue and auth state", auth: true },
  { method: "POST", path: "/brief", note: "build a brief and discard it — costs nothing", auth: true },
  { method: "GET", path: "/jobs", note: "every job, newest first", auth: true },
  { method: "POST", path: "/jobs", note: "create from answers — does NOT generate", auth: true },
  { method: "GET", path: "/jobs/:id", note: "one job, with attempt history", auth: true },
  { method: "POST", path: "/jobs/:id/generate", note: "generate; body may override the brief", auth: true },
  { method: "GET", path: "/jobs/:id/audio", note: "latest take; supports Range", auth: true },
];

// --- plumbing ---------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class HttpError extends Error {
  // Written out longhand rather than as constructor parameter properties, which
  // Node's --experimental-strip-types cannot compile: stripping types is a purely
  // syntactic transform, and parameter properties need code generated for them.
  readonly status: number;
  readonly detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {};

  // Exact-match allowlist. The site is a static export calling this from a
  // browser, so CORS is load-bearing rather than ceremonial — but reflecting
  // arbitrary origins would hand any page on the internet an authenticated
  // channel to a service that spends money and holds customer data.
  if (!config.allowedOrigins.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...corsHeaders(req),
  });
  res.end(payload);
}

function sendHtml(req: IncomingMessage, res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    ...corsHeaders(req),
  });
  res.end(html);
}


/**
 * Serve audio with Range support.
 *
 * Without this, `<audio>` can play a file but cannot reliably seek within it —
 * the browser asks for a byte range, gets the whole file and a 200, and scrubbing
 * behaves inconsistently across browsers. The studio page is built around
 * scrubbing through a take, so this matters.
 */
function sendAudio(
  req: IncomingMessage,
  res: ServerResponse,
  audio: Buffer,
  contentType: string,
  filename: string,
): void {
  const common = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Takes are immutable once written, so they can be cached hard. But this is
    // customer material, so: private, never a shared cache.
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `inline; filename="${filename}"`,
    ...corsHeaders(req),
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const [, rawStart, rawEnd] = match;
      let start = rawStart ? Number.parseInt(rawStart, 10) : 0;
      let end = rawEnd ? Number.parseInt(rawEnd, 10) : audio.length - 1;

      // "bytes=-500" means the last 500 bytes, not "from 0 to 500".
      if (!rawStart && rawEnd) {
        start = Math.max(0, audio.length - Number.parseInt(rawEnd, 10));
        end = audio.length - 1;
      }

      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < audio.length) {
        end = Math.min(end, audio.length - 1);
        const slice = audio.subarray(start, end + 1);
        res.writeHead(206, {
          ...common,
          "Content-Range": `bytes ${start}-${end}/${audio.length}`,
          "Content-Length": slice.length,
        });
        res.end(slice);
        return;
      }

      res.writeHead(416, { ...common, "Content-Range": `bytes */${audio.length}` });
      res.end();
      return;
    }
  }

  res.writeHead(200, { ...common, "Content-Length": audio.length });
  res.end(audio);
}

/**
 * Bearer check.
 *
 * `timingSafeEqual` rather than `===` because a plain comparison leaks the token
 * one character at a time to anyone willing to measure. The service is small;
 * that is not a reason for it to be guessable. Lengths are compared first because
 * timingSafeEqual throws on a length mismatch.
 */
const COOKIE_NAME = "operator";

function readCookie(req: IncomingMessage, name: string): string {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function authorise(req: IncomingMessage): void {
  // No token configured means no authentication. Explicit and early, rather than
  // falling through to a comparison of two empty strings that happens to pass —
  // the behaviour should be obvious in the code, not an accident of it.
  if (authIsOpen()) return;

  const header = req.headers.authorization ?? "";
  /**
   * Header for API clients, cookie for the studio page.
   *
   * The cookie is what makes `<audio src="/jobs/x/audio">` work: an audio element
   * cannot send an Authorization header, and putting the token in the query string
   * would write it into browser history and every access log between here and the
   * browser. A cookie is sent automatically on a same-origin request, so playback
   * and seeking work with no special handling at all.
   */
  const presented = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : readCookie(req, COOKIE_NAME);

  const expected = config.operatorToken;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, "a valid operator token is required");
  }
}

function parseAnswers(raw: string): Answers {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "body was not valid JSON");
  }
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "body must be a JSON object");
  }

  const answers = body as Record<string, unknown>;
  const petName = typeof answers.petName === "string" ? answers.petName.trim() : "";
  const memories = typeof answers.memories === "string" ? answers.memories.trim() : "";

  if (!petName) throw new HttpError(400, "petName is required — the song is about them");
  if (!memories) {
    throw new HttpError(
      400,
      "memories is required — it is what the verses are built from, and without it there is no song",
    );
  }

  const pick = (key: string): string | undefined =>
    typeof answers[key] === "string" ? (answers[key] as string) : undefined;

  return {
    petName,
    memories,
    species: pick("species") as Answers["species"],
    about: pick("about"),
    personality: pick("personality"),
    include: pick("include"),
    style: pick("style") as Answers["style"],
    yourName: pick("yourName"),
    email: pick("email"),
  };
}

/** Only the fields an operator is allowed to override, and only if well-typed. */
function parseBriefOverrides(raw: unknown): Partial<SongBrief> {
  if (typeof raw !== "object" || raw === null) return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<SongBrief> = {};

  if (typeof input.title === "string") out.title = input.title;
  if (typeof input.caption === "string") out.caption = input.caption;
  if (typeof input.lyrics === "string") out.lyrics = input.lyrics;
  if (typeof input.vocalLanguage === "string") out.vocalLanguage = input.vocalLanguage;
  if (typeof input.keyScale === "string") out.keyScale = input.keyScale;
  if (typeof input.timeSignature === "string") out.timeSignature = input.timeSignature;
  if (typeof input.durationSeconds === "number") out.durationSeconds = input.durationSeconds;
  if (typeof input.bpm === "number") out.bpm = input.bpm;

  return out;
}

/** The public view of a job. Never leaks the customer's email to the response. */
function jobView(job: Job): Record<string, unknown> {
  const { email, ...answersWithoutEmail } = job.answers;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    take: job.take,
    brief: job.brief,
    result: job.result,
    error: job.error,
    attempts: job.attempts,
    takes: listTakes(job.id),
    answers: answersWithoutEmail,
    /** Present so the operator knows there is somewhere to send it, not what. */
    hasEmail: Boolean(email),
  };
}

// --- routes -----------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  // Unauthenticated: useful for a load balancer, tells an anonymous caller
  // nothing beyond "this is up".
  if (path === "/health" && method === "GET") {
    sendJson(req, res, 200, { ok: true, service: "tails-song-api" });
    return;
  }

  /**
   * The root.
   *
   * This exists because its absence made a working deploy look like a broken
   * one: the first thing anybody does with a fresh service URL is open it in a
   * browser, and what they got back was `no route GET /`. A 404 at the front door
   * reads as "this is broken", not "you wanted a different path".
   *
   * Deliberately says nothing a stranger shouldn't see — no jobs, no counts, no
   * customer data — because when OPERATOR_TOKEN is unset this is public.
   */
  if (path === "/" && method === "GET") {
    const wantsHtml = (req.headers.accept ?? "").includes("text/html");
    if (wantsHtml) {
      // The studio itself, unauthenticated, because the page needs to render in
      // order to offer a sign-in. Every route it calls is still checked.
      sendHtml(req, res, studioPage());
    } else {
      sendJson(req, res, 200, {
        service: "tails-song-api",
        ok: true,
        provider: config.provider,
        auth: authIsOpen() ? "open" : "token",
        routes: ROUTES.map((r) => `${r.method} ${r.path}`),
      });
    }
    return;
  }

  // Browsers ask for this unprompted. Answering quietly beats a 404 in the log
  // every time someone opens the URL.
  if (path === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  /**
   * Exchange the token for a cookie.
   *
   * Unauthenticated by necessity — this is how you become authenticated. It is
   * also the one place a wrong token is expected, so it returns 401 with a plain
   * message rather than the generic one.
   */
  if (path === "/login" && method === "POST") {
    if (authIsOpen()) {
      sendJson(req, res, 200, { ok: true, note: "no token is configured; nothing to sign in to" });
      return;
    }
    const raw = await readBody(req);
    let presented = "";
    try {
      presented = String((JSON.parse(raw || "{}") as { token?: unknown }).token ?? "").trim();
    } catch {
      throw new HttpError(400, "body was not valid JSON");
    }

    const a = Buffer.from(presented);
    const b = Buffer.from(config.operatorToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new HttpError(401, "that token doesn't match this service's OPERATOR_TOKEN");
    }

    // HttpOnly so page scripts can't read it back out. SameSite=Lax rather than
    // Strict so the cookie survives arriving from an external link. Secure only
    // when the request actually came over TLS, or the cookie is silently dropped
    // in local development over plain http.
    const secure =
      (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0]?.trim() === "https";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(presented)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${
        60 * 60 * 24 * 30
      }${secure ? "; Secure" : ""}`,
    );
    sendJson(req, res, 200, { ok: true });
    return;
  }

  authorise(req);

  // --- provider + queue introspection ---
  if (path === "/status" && method === "GET") {
    const health = await getProvider().health();
    sendJson(req, res, 200, {
      provider: health,
      queue: queueStatus(),
      // Reported so the studio can show it. An open service should be visible in
      // the UI, not only in a boot log nobody re-reads.
      auth: authIsOpen() ? "open" : "token",
      /**
       * Surfaced because it is the difference between "songs work" and "every
       * job 504s", and it is the first thing to check when the latter happens.
       */
      thinking: config.provider === "acemusic" ? config.acemusic.thinking : true,
    });
    return;
  }

  // --- pasted email -> answers ---
  if (path === "/parse" && method === "POST") {
    const raw = await readBody(req);
    let text = "";
    try {
      text = String((JSON.parse(raw || "{}") as { text?: unknown }).text ?? "");
    } catch {
      throw new HttpError(400, "body was not valid JSON");
    }
    const { answers, matched } = parseSummary(text);
    sendJson(req, res, 200, {
      answers,
      matched,
      // Human-readable names, so the page can say what it read without needing
      // its own copy of the label table.
      labels: matched.map((key) => LABELS[key] ?? key),
    });
    return;
  }

  // --- dry-run a brief without spending a generation ---
  if (path === "/brief" && method === "POST") {
    const raw = await readBody(req);
    const answers = parseAnswers(raw);
    const overrides = parseBriefOverrides((JSON.parse(raw) as { brief?: unknown }).brief);
    const result = buildBrief(answers, overrides);
    sendJson(req, res, 200, {
      brief: result.brief,
      warnings: result.warnings,
      notes: result.notes,
      unusedLines: result.unusedLines,
      problems: validateBrief(result.brief),
    });
    return;
  }

  // --- jobs ---
  if (path === "/jobs" && method === "GET") {
    sendJson(req, res, 200, { jobs: listJobs().map(jobView), queue: queueStatus() });
    return;
  }

  if (path === "/jobs" && method === "POST") {
    const raw = await readBody(req);
    const answers = parseAnswers(raw);
    const parsed = JSON.parse(raw) as { brief?: unknown; generate?: unknown };
    const overrides = parseBriefOverrides(parsed.brief);

    const built = buildBrief(answers, overrides);
    const problems = validateBrief(built.brief);

    // Default to *not* generating. A job is created, the operator reads the
    // lyrics, and generation is a separate deliberate act. Sending a song built
    // from an unreviewed draft to someone who has just lost their dog is the
    // single worst thing this service could do, so it is not the default path.
    const shouldGenerate = parsed.generate === true && problems.length === 0;

    const job = createJob(answers, built.brief);
    if (shouldGenerate) enqueue(job.id);

    sendJson(req, res, 201, {
      job: jobView(job),
      warnings: built.warnings,
      notes: built.notes,
      unusedLines: built.unusedLines,
      problems,
      queued: shouldGenerate,
      ...(problems.length && parsed.generate === true
        ? { message: "not queued — the brief has problems listed above" }
        : {}),
    });
    return;
  }

  const jobMatch = /^\/jobs\/([A-Za-z0-9_-]{4,32})(\/.*)?$/.exec(path);
  if (jobMatch) {
    const id = jobMatch[1]!;
    const rest = jobMatch[2] ?? "";
    const job = getJob(id);
    if (!job) throw new HttpError(404, `no job ${id}`);

    if (rest === "" && method === "GET") {
      sendJson(req, res, 200, { job: jobView(job) });
      return;
    }

    // Latest take, or a named one.
    const audioMatch = /^\/audio(?:\/(take-\d+\.(?:mp3|wav|flac|opus|aac)))?$/.exec(rest);
    if (audioMatch && method === "GET") {
      const filename = audioMatch[1] ?? job.result?.audioFile;
      if (!filename) throw new HttpError(404, "this job has no audio yet");
      const audio = readTake(id, filename);
      if (!audio) throw new HttpError(404, `no take ${filename}`);
      const type = filename.endsWith(".wav")
        ? "audio/wav"
        : filename.endsWith(".flac")
          ? "audio/flac"
          : "audio/mpeg";
      // A filename someone can find again on their desktop.
      const safeTitle = job.brief.title.replace(/[^\w\s-]/g, "").trim() || job.answers.petName;
      const ext = filename.slice(filename.lastIndexOf("."));
      sendAudio(req, res, audio, type, `${job.answers.petName} - ${safeTitle}${ext}`);
      return;
    }

    if (rest === "/generate" && method === "POST") {
      if (job.status === "generating") {
        throw new HttpError(409, "this job is already generating");
      }
      const raw = await readBody(req).catch(() => "{}");
      const overrides = parseBriefOverrides(
        (JSON.parse(raw || "{}") as { brief?: unknown }).brief,
      );

      // The operator's edits are the brief from here on. This is the point of
      // the whole design: what gets generated is what a human approved.
      const brief: SongBrief = { ...job.brief, ...overrides };
      const problems = validateBrief(brief);
      if (problems.length > 0) {
        throw new HttpError(422, "the brief has problems", problems);
      }

      job.brief = brief;
      delete job.error;
      saveJob(job);
      enqueue(job.id); // sets the status, so the two can't disagree

      sendJson(req, res, 202, { job: jobView(job), queue: queueStatus() });
      return;
    }

    throw new HttpError(404, `no route ${method} ${path}`, {
      jobFound: id,
      routes: ROUTES.filter((r) => r.path.startsWith("/jobs/:id")).map(
        (r) => `${r.method} /jobs/${id}${r.path.slice("/jobs/:id".length)}`,
      ),
    });
  }

  throw new HttpError(404, `no route ${method} ${path}`, {
    routes: ROUTES.map((r) => `${r.method} ${r.path}`),
  });
}

// --- server -----------------------------------------------------------------

export function startServer(): void {
  const server = createServer((req, res) => {
    const started = Date.now();

    route(req, res)
      .catch((err: unknown) => {
        if (res.headersSent) return;
        if (err instanceof HttpError) {
          sendJson(req, res, err.status, {
            error: err.message,
            ...(err.detail ? { detail: err.detail } : {}),
          });
          return;
        }
        log.error("unhandled request failure", {
          method: req.method,
          path: req.url,
          error: (err as Error)?.message ?? String(err),
          stack: (err as Error)?.stack?.split("\n").slice(0, 4).join(" | "),
        });
        sendJson(req, res, 500, { error: "internal error" });
      })
      .finally(() => {
        // 401s are logged too — a stream of them is the signal that something is
        // scanning, or that the studio page has a stale token.
        log.info("request", {
          method: req.method,
          path: req.url?.split("?")[0],
          status: res.statusCode,
          ms: Date.now() - started,
        });
      });
  });

  // Generation takes tens of seconds and a client may hold a connection open
  // while polling. Node's 5s default header timeout is too tight for that.
  server.headersTimeout = 120_000;
  server.requestTimeout = 180_000;

  // No host argument on purpose. Node then binds `::`, which accepts both IPv6
  // and IPv4 traffic; hardcoding "0.0.0.0" would bind IPv4 only and silently
  // fail on any platform that routes internal traffic over IPv6. `PORT` comes
  // from the environment because every host injects its own.
  server.listen(config.port, () => {
    log.info("listening", { port: config.port, provider: config.provider });
  });
}
