// All configuration comes from the environment (never from code), is parsed and validated
// in exactly one place, and the process refuses to start on a bad value: a typo in PORT
// should fail loudly at boot, not become `NaN` three layers down.
//
// Lab 6: the environment is `unknown` text, so it is a Zod schema like any other boundary.
// `ServerConfig` is inferred from it — the type the rest of the server sees is exactly what
// the schema produces, with every number already a number.

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_CLIENT_DIST = resolve(import.meta.dirname, "../../client/dist");

const int = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .transform(Number)
    .refine((n) => n >= min && n <= max, `must be between ${min} and ${max}`);

const BOOL_WORDS: ReadonlyMap<string, boolean> = new Map([
  ["1", true],
  ["true", true],
  ["0", false],
  ["false", false],
  ["", false],
]);

const bool = z
  .string()
  .refine((s) => BOOL_WORDS.has(s.toLowerCase()), 'must be "1", "0", "true" or "false"')
  .transform((s) => BOOL_WORDS.get(s.toLowerCase()) === true);

const text = z
  .string()
  .refine((s) => s.trim() !== "", "must not be empty")
  .transform((s) => s.trim());

/** A directory setting: relative paths are resolved against the working directory. */
const dir = (cwd: string) =>
  z
    .string()
    .refine((s) => s.trim() !== "", "must not be empty")
    .transform((s) => (isAbsolute(s) ? s : resolve(cwd, s)));

// Keys are the ENV names, in the order problems are reported; the transform at the end gives
// them the names the code uses. PORT / LOG_DIR (and friends) are the ones the lab names; the
// rest are limits that are env-configurable mostly so tests can shrink them.
function envSchema(cwd: string, env: Env) {
  return z
    .object({
      PORT: int(0, 65535).default(3000),
      HOST: text.default("127.0.0.1"),
      LOG_DIR: dir(cwd).default(resolve(cwd, "logs")),
      CLIENT_DIST: dir(cwd).default(DEFAULT_CLIENT_DIST),
      MAX_MESSAGE_BYTES: int(64, 1 << 20).default(2048),
      MAX_BODY_BYTES: int(64, 1 << 20).default(4096),
      JOIN_TIMEOUT_MS: int(10, 600_000).default(5000),
      HEARTBEAT_MS: int(10, 600_000).default(15_000),
      MAX_MISSED_PONGS: int(1, 100).default(2),
      RATE_PER_SEC: int(1, 10_000).default(10),
      RATE_BURST: int(1, 10_000).default(20),
      MAX_ROOMS: int(1, 10_000).default(20),
      MAX_PLAYERS_PER_ROOM: int(1, 1000).default(8),
      ROOM_IDLE_MS: int(10, 86_400_000).default(60_000),
      SLOW_DROP_BYTES: int(1, 1 << 30).default(64 * 1024),
      SLOW_CLOSE_BYTES: int(1, 1 << 30).default(1024 * 1024),
      SHUTDOWN_GRACE_MS: int(0, 600_000).default(3000),
      INPUT_RESERVE: int(0, 10).default(1),
      ENABLE_DEBUG_ROUTES: bool.default(false),
      // Artificial latency/jitter/loss for developing netcode (Lab 5). On unless NODE_ENV=production.
      ENABLE_NETSIM: bool.default(env.NODE_ENV !== "production"),
      // POST /api/rooms/:id/bots: AI players, for demos, profiling and load tests (Lab 7). Same default.
      ENABLE_BOTS: bool.default(env.NODE_ENV !== "production"),
    })
    .transform((e) => ({
      port: e.PORT,
      host: e.HOST,
      logDir: e.LOG_DIR,
      clientDist: e.CLIENT_DIST,
      maxMessageBytes: e.MAX_MESSAGE_BYTES,
      maxBodyBytes: e.MAX_BODY_BYTES,
      joinTimeoutMs: e.JOIN_TIMEOUT_MS,
      heartbeatMs: e.HEARTBEAT_MS,
      maxMissedPongs: e.MAX_MISSED_PONGS,
      ratePerSec: e.RATE_PER_SEC,
      rateBurst: e.RATE_BURST,
      maxRooms: e.MAX_ROOMS,
      maxPlayersPerRoom: e.MAX_PLAYERS_PER_ROOM,
      roomIdleMs: e.ROOM_IDLE_MS,
      slowDropBytes: e.SLOW_DROP_BYTES,
      slowCloseBytes: e.SLOW_CLOSE_BYTES,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
      inputReserve: e.INPUT_RESERVE,
      debugRoutes: e.ENABLE_DEBUG_ROUTES,
      netsim: e.ENABLE_NETSIM,
      bots: e.ENABLE_BOTS,
    }));
}

/** What `process.env` looks like: strings, or nothing. */
export type Env = Readonly<Record<string, string | undefined>>;

export type ServerConfig = Readonly<z.output<ReturnType<typeof envSchema>>>;

/** `err.code` of a Node system error, or undefined for anything else that was thrown. */
function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

export function loadConfig(
  env: Env = process.env,
  { cwd = process.cwd() }: { cwd?: string } = {},
): ServerConfig {
  const parsed = envSchema(cwd, env).safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const name = String(issue.path[0] ?? "env");
        return `${name}=${JSON.stringify(env[name])}: ${issue.message}`;
      }),
    );
  }
  const config = parsed.data;
  const problems: string[] = [];

  // The log directory is created on start-up; here we only reject a path that exists and
  // is not a directory (a file called "logs" would otherwise fail much later).
  try {
    if (!statSync(config.logDir).isDirectory()) {
      problems.push(`LOG_DIR=${JSON.stringify(config.logDir)}: exists and is not a directory`);
    }
  } catch (err: unknown) {
    if (errorCode(err) !== "ENOENT") {
      problems.push(`LOG_DIR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (config.slowCloseBytes <= config.slowDropBytes) {
    problems.push("SLOW_CLOSE_BYTES must be greater than SLOW_DROP_BYTES");
  }
  if (config.rateBurst < config.ratePerSec) {
    problems.push("RATE_BURST must be at least RATE_PER_SEC");
  }

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}
