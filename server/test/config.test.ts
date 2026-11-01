import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";

test("defaults: port 3000, LOG_DIR resolved against the working directory", () => {
  const c = loadConfig({}, { cwd: "/srv/app" });
  assert.equal(c.port, 3000);
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.logDir, resolve("/srv/app", "logs"));
  assert.equal(c.maxMessageBytes, 2048);
  assert.equal(c.heartbeatMs, 15_000);
  assert.equal(c.joinTimeoutMs, 5000);
  assert.equal(c.debugRoutes, false);
});

test("PORT and LOG_DIR come from the environment", () => {
  const c = loadConfig({ PORT: "8080", LOG_DIR: "/var/log/dogfight" });
  assert.equal(c.port, 8080);
  assert.equal(c.logDir, "/var/log/dogfight");
});

test("config is frozen", () => {
  assert.throws(() => {
    // @ts-expect-error `ServerConfig` is readonly: the compiler refuses it, and Object.freeze does too
    loadConfig({}).port = 1;
  }, TypeError);
});

test("bad values are rejected, all problems reported at once", () => {
  assert.throws(
    () => loadConfig({ PORT: "abc", HEARTBEAT_MS: "5", ENABLE_DEBUG_ROUTES: "maybe" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.problems.length, 3);
      assert.match(err.message, /PORT="abc"/);
      assert.match(err.message, /HEARTBEAT_MS/);
      assert.match(err.message, /ENABLE_DEBUG_ROUTES/);
      return true;
    },
  );
});

test("PORT out of range, fractional or empty is rejected", () => {
  for (const PORT of ["70000", "-1", "80.5", "", " "]) {
    assert.throws(() => loadConfig({ PORT }), ConfigError, `PORT=${JSON.stringify(PORT)}`);
  }
});

test("an empty LOG_DIR is rejected", () => {
  assert.throws(() => loadConfig({ LOG_DIR: "  " }), /LOG_DIR/);
});

test("LOG_DIR that exists but is a file is rejected", () => {
  assert.throws(() => loadConfig({ LOG_DIR: import.meta.filename }), /not a directory/);
});

test("cross-field checks: close threshold above drop threshold, burst ≥ rate", () => {
  assert.throws(
    () => loadConfig({ SLOW_DROP_BYTES: "1000", SLOW_CLOSE_BYTES: "1000" }),
    /SLOW_CLOSE/,
  );
  assert.throws(() => loadConfig({ RATE_PER_SEC: "50", RATE_BURST: "10" }), /RATE_BURST/);
});

test("Lab 5 settings: input reserve (jitter buffer) and the network simulator", () => {
  assert.equal(loadConfig({}).inputReserve, 1);
  assert.equal(loadConfig({ INPUT_RESERVE: "0" }).inputReserve, 0);
  assert.throws(() => loadConfig({ INPUT_RESERVE: "-1" }), ConfigError);
  assert.throws(() => loadConfig({ INPUT_RESERVE: "99" }), ConfigError);
});

test("ENABLE_NETSIM defaults to on, except in production; an explicit value always wins", () => {
  assert.equal(loadConfig({}).netsim, true);
  assert.equal(loadConfig({ NODE_ENV: "development" }).netsim, true);
  assert.equal(loadConfig({ NODE_ENV: "production" }).netsim, false);
  assert.equal(loadConfig({ NODE_ENV: "production", ENABLE_NETSIM: "1" }).netsim, true);
  assert.equal(loadConfig({ ENABLE_NETSIM: "0" }).netsim, false);
  assert.throws(() => loadConfig({ ENABLE_NETSIM: "sure" }), /ENABLE_NETSIM/);
});
