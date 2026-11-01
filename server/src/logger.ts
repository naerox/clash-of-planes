// Structured logs: one JSON object per line on stdout, written by `pino`.
//
// Why pino and not `console.log(JSON.stringify(...))`: it serialises with a precompiled
// per-shape function and writes asynchronously, so a log line costs microseconds on the
// event loop — the same lesson as Lab 4 (a blocked loop is a dropped tick). Why stdout and
// not a file: in a container the platform collects stdout; a file inside the container
// disappears with it.
//
// The rest of the server only sees the small `Logger` interface below, so tests pass a
// silent one and nothing else needs to know pino exists.

import { pino, type DestinationStream } from "pino";

export type LogFields = Readonly<Record<string, unknown>>;
export type LogFn = (msg: string, fields?: LogFields) => void;

export interface Logger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
  /** The process is about to exit because of this. */
  readonly fatal: LogFn;
  /** The same logger with `bindings` (`roomId`, `playerId`, …) added to every line. */
  child(bindings: LogFields): Logger;
}

export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Keys whose values are never written, wherever they appear (one level deep as well). */
export const REDACTED_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "cookie",
  "dsn",
];

export interface LoggerOptions {
  level?: LogLevel;
  /** Defaults to stdout; tests pass an array-backed stream to read the lines back. */
  stream?: DestinationStream;
  /** Fields on every line, e.g. `{ version }`. */
  base?: LogFields;
}

function wrap(p: pino.Logger): Logger {
  const at =
    (level: "debug" | "info" | "warn" | "error" | "fatal"): LogFn =>
    (msg, fields) => {
      p[level](fields ?? {}, msg);
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
    child: (bindings) => wrap(p.child({ ...bindings })),
  };
}

export function createLogger({ level = "info", stream, base = {} }: LoggerOptions = {}): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: "dogfight", ...base },
    // "level":"info" rather than pino's numeric 30: readable in a log viewer, greppable
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: [...REDACTED_KEYS, ...REDACTED_KEYS.map((k) => `*.${k}`)],
      censor: "[redacted]",
    },
  };
  return wrap(stream ? pino(options, stream) : pino(options));
}

const nothing: LogFn = () => {};
export const silentLogger: Logger = {
  debug: nothing,
  info: nothing,
  warn: nothing,
  error: nothing,
  fatal: nothing,
  child: () => silentLogger,
};
