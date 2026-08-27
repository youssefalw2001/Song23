/**
 * Structured-enough logging. One line per event, greppable, no dependency.
 *
 * Never log the API key or a customer's email. The upstream project has an open
 * issue about keys leaking through logs and intermediaries
 * (ace-step/ACE-Step-1.5#1130); no reason to repeat it here.
 */

type Fields = Record<string, unknown>;

const REDACT = /^(.*(key|token|secret|authorization|email).*)$/i;

function render(fields: Fields): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const value = REDACT.test(k) ? "[redacted]" : typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${typeof value === "string" && value.includes(" ") ? JSON.stringify(value) : value}`);
  }
  return parts.join(" ");
}

function emit(level: string, msg: string, fields: Fields = {}): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${
    Object.keys(fields).length ? " " + render(fields) : ""
  }`;
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
  debug: (msg: string, fields?: Fields) => {
    if (process.env.DEBUG) emit("debug", msg, fields);
  },
};
