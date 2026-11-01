// All configuration comes from the environment (never from code), is parsed and validated
// in exactly one place, and the process refuses to start on a bad value: a typo in PORT
// should fail loudly at boot, not become `NaN` three layers down.

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const DEFAULT_CLIENT_DIST = resolve(import.meta.dirname, "../../client/dist");

const int = (min, max) => ({
  parse(raw) {
    if (!/^\d+$/.test(raw)) throw new Error("must be a non-negative integer");
    const n = Number(raw);
    if (n < min || n > max) throw new Error(`must be between ${min} and ${max}`);
    return n;
  },
});

const bool = {
  parse(raw) {
    if (["1", "true"].includes(raw.toLowerCase())) return true;
    if (["0", "false", ""].includes(raw.toLowerCase())) return false;
    throw new Error('must be "1", "0", "true" or "false"');
  },
};

const text = {
  parse(raw) {
    if (!raw.trim()) throw new Error("must not be empty");
    return raw.trim();
  },
};

// [ENV name, config key, parser, default]. PORT / LOG_DIR (and friends) are the ones the lab
// names; the rest are limits that are env-configurable mostly so tests can shrink them.
const SPEC = [
  ["PORT", "port", int(0, 65535), 3000],
  ["HOST", "host", text, "127.0.0.1"],
  ["LOG_DIR", "logDir", "dir", "logs"],
  ["CLIENT_DIST", "clientDist", "dir", DEFAULT_CLIENT_DIST],
  ["MAX_MESSAGE_BYTES", "maxMessageBytes", int(64, 1 << 20), 2048],
  ["MAX_BODY_BYTES", "maxBodyBytes", int(64, 1 << 20), 4096],
  ["JOIN_TIMEOUT_MS", "joinTimeoutMs", int(10, 600_000), 5000],
  ["HEARTBEAT_MS", "heartbeatMs", int(10, 600_000), 15_000],
  ["MAX_MISSED_PONGS", "maxMissedPongs", int(1, 100), 2],
  ["RATE_PER_SEC", "ratePerSec", int(1, 10_000), 10],
  ["RATE_BURST", "rateBurst", int(1, 10_000), 20],
  ["MAX_ROOMS", "maxRooms", int(1, 10_000), 20],
  ["MAX_PLAYERS_PER_ROOM", "maxPlayersPerRoom", int(1, 1000), 8],
  ["ROOM_IDLE_MS", "roomIdleMs", int(10, 86_400_000), 60_000],
  ["SLOW_DROP_BYTES", "slowDropBytes", int(1, 1 << 30), 64 * 1024],
  ["SLOW_CLOSE_BYTES", "slowCloseBytes", int(1, 1 << 30), 1024 * 1024],
  ["SHUTDOWN_GRACE_MS", "shutdownGraceMs", int(0, 600_000), 3000],
  ["ENABLE_DEBUG_ROUTES", "debugRoutes", bool, false],
];

export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const config = {};
  const problems = [];

  for (const [name, key, parser, fallback] of SPEC) {
    const raw = env[name];
    if (raw === undefined) {
      config[key] = parser === "dir" ? resolve(cwd, fallback) : fallback;
      continue;
    }
    try {
      if (parser === "dir") {
        if (!raw.trim()) throw new Error("must not be empty");
        config[key] = isAbsolute(raw) ? raw : resolve(cwd, raw);
      } else {
        config[key] = parser.parse(raw);
      }
    } catch (err) {
      problems.push(`${name}=${JSON.stringify(raw)}: ${err.message}`);
    }
  }

  if (!problems.length) {
    // The log directory is created on start-up; here we only reject a path that exists and
    // is not a directory (a file called "logs" would otherwise fail much later).
    try {
      if (!statSync(config.logDir).isDirectory()) {
        problems.push(`LOG_DIR=${JSON.stringify(config.logDir)}: exists and is not a directory`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") problems.push(`LOG_DIR: ${err.message}`);
    }
    if (config.slowCloseBytes <= config.slowDropBytes) {
      problems.push("SLOW_CLOSE_BYTES must be greater than SLOW_DROP_BYTES");
    }
    if (config.rateBurst < config.ratePerSec) {
      problems.push("RATE_BURST must be at least RATE_PER_SEC");
    }
  }

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}
