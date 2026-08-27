/**
 * Boot.
 *
 * Validate configuration before opening a socket. A service that discovers a
 * missing API key on the first real request has already wasted the operator's
 * time; one that refuses to start says so in the deploy log.
 */

import { config, validateConfig, configWarnings } from "./config.ts";
import { log } from "./log.ts";
import { initStore } from "./jobs/store.ts";
import { resumeOnBoot } from "./jobs/queue.ts";
import { startServer } from "./http/server.ts";

const problems = validateConfig();
if (problems.length > 0) {
  process.stderr.write("\nRefusing to start. Fix these, then try again:\n\n");
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
  process.stderr.write("\nSee .env.example for what each setting does.\n\n");
  process.exit(1);
}

for (const warning of configWarnings()) log.warn(warning);

initStore();
resumeOnBoot();
startServer();

log.info("tails-song-api up", {
  provider: config.provider,
  dataDir: config.dataDir,
  origins: config.allowedOrigins.join(","),
});

/**
 * Let an in-flight generation finish rather than killing it.
 *
 * A job interrupted mid-provider-call is unrecoverable on the hosted tier — the
 * API is synchronous, so there is no task id left to resume from, and the work
 * is simply lost. Waiting a few seconds on shutdown is cheaper than a stranded
 * job and a confused operator.
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info(`${signal} received, finishing current work`);
    setTimeout(() => process.exit(0), 3_000);
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
