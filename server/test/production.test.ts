// Lab 8: the server as a production process — probes, metrics, the handshake gate, logs, crashes.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { ConfigError, loadConfig } from "../src/config.ts";
import { installCrashHandlers, type ProcessLike } from "../src/crash.ts";
import { createLogger } from "../src/logger.ts";
import { clientIp, originAllowed, rejectionFor } from "../src/ws.ts";
import { connect, hello, openRoom, startApp } from "./helpers.ts";

const field = (m: unknown, key: string): unknown =>
  typeof m === "object" && m !== null ? Object.entries(m).find(([k]) => k === key)?.[1] : undefined;

const getJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  const body: unknown = await res.json();
  return { status: res.status, body };
};

/** Resolves with the HTTP status the server answered a WebSocket handshake with (or "open"). */
function handshake(url: string, origin?: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      url,
      origin === undefined ? undefined : { headers: { Origin: origin } },
    );
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on("open", () => {
      resolve("open");
      ws.close();
    });
    ws.on("error", () => {});
  });
}

// ── probes ─────────────────────────────────────────────────────────────────────────────

test("/health says who is running: version and git sha", async () => {
  const srv = await startApp({ APP_VERSION: "v1.2.3", GIT_SHA: "abc1234" });
  try {
    const { status, body } = await getJson(`${srv.base}/health`);
    assert.equal(status, 200);
    assert.equal(field(body, "status"), "ok");
    assert.equal(field(body, "version"), "v1.2.3");
    assert.equal(field(body, "sha"), "abc1234");
  } finally {
    await srv.close();
  }
});

test("/ready is 200 with a client build, 503 without one — and /health stays 200 either way", async () => {
  const srv = await startApp();
  try {
    assert.equal(
      (await fetch(`${srv.base}/ready`)).status,
      503,
      "CLIENT_DIST is an empty directory",
    );
    assert.equal((await fetch(`${srv.base}/health`)).status, 200, "alive is not the same as ready");
    await writeFile(join(srv.dir, "index.html"), "<!doctype html>");
    const ok = await getJson(`${srv.base}/ready`);
    assert.deepEqual([ok.status, field(ok.body, "ready")], [200, true]);
  } finally {
    await srv.close();
  }
});

test("/ready turns 503 the moment shutdown begins (before any socket is closed)", async () => {
  const srv = await startApp();
  await writeFile(join(srv.dir, "index.html"), "<!doctype html>");
  const room = await openRoom(srv.base);
  const c = connect(srv.wsUrl);
  await c.opened;
  c.send(hello(room.id, "Ace"));
  await c.nextOf("joined");
  assert.equal((await srv.app.readiness()).ready, true);
  const stopping = srv.app.shutdown();
  assert.deepEqual(await srv.app.readiness(), { ready: false, reason: "shutting down" });
  await c.closed;
  await stopping;
  await rm(srv.dir, { recursive: true, force: true });
});

test("shutdown tells the client why (a `shutdown` message), then closes with 1001", async () => {
  const srv = await startApp();
  const room = await openRoom(srv.base);
  const c = connect(srv.wsUrl);
  await c.opened;
  c.send(hello(room.id, "Ace"));
  await c.nextOf("joined");
  const stopping = srv.app.shutdown();
  const said = await c.nextOf("shutdown");
  assert.equal(said.reason, "server shutting down");
  assert.ok(said.reconnectAfterMs > 0);
  assert.equal((await c.closed).code, 1001);
  await stopping;
  await rm(srv.dir, { recursive: true, force: true });
});

// ── /metrics ───────────────────────────────────────────────────────────────────────────

const metric = (text: string, name: string, labels = ""): number => {
  const line = text.split("\n").find((l) => l.startsWith(`${name}${labels} `));
  return line ? Number(line.slice(name.length + labels.length + 1)) : Number.NaN;
};

test("/metrics: players, rooms, messages, bytes, tick time and the build, in the Prometheus format", async () => {
  const srv = await startApp({ APP_VERSION: "v9", GIT_SHA: "deadbee" });
  try {
    const room = await openRoom(srv.base);
    const c = connect(srv.wsUrl);
    await c.opened;
    c.send(hello(room.id, "Ace"));
    await c.nextOf("joined");
    await c.untilSnapshot(() => true);
    c.send({ v: 1, type: "chat", text: "hi" });
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`${srv.base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const text = await res.text();
    assert.equal(metric(text, "dogfight_players"), 1);
    assert.equal(metric(text, "dogfight_rooms"), 1);
    assert.equal(metric(text, "dogfight_connections"), 1);
    assert.ok(metric(text, "dogfight_messages_in_total", '{type="join"}') >= 1);
    assert.ok(metric(text, "dogfight_messages_in_total", '{type="chat"}') >= 1);
    assert.ok(metric(text, "dogfight_messages_out_total") >= 2, "joined + snapshots");
    assert.ok(metric(text, "dogfight_bytes_out_total") > 100);
    assert.ok(metric(text, "dogfight_tick_duration_seconds_count") >= 1);
    assert.ok(metric(text, "dogfight_tick_p99_seconds") >= 0);
    const elu = metric(text, "dogfight_event_loop_utilization");
    assert.ok(elu >= 0 && elu <= 1, `ELU ${elu}`);
    assert.match(text, /dogfight_build_info\{version="v9",git_sha="deadbee"\} 1/);
    assert.match(
      text,
      /dogfight_rejections_total\{reason="origin"\} 0/,
      "every reason is present from the start",
    );
    c.socket.close();
  } finally {
    await srv.close();
  }
});

test("METRICS_TOKEN: without the bearer token /metrics is 401", async () => {
  const srv = await startApp({ METRICS_TOKEN: "s3cret-token" });
  try {
    assert.equal((await fetch(`${srv.base}/metrics`)).status, 401);
    assert.equal(
      (await fetch(`${srv.base}/metrics`, { headers: { Authorization: "Bearer wrong" } })).status,
      401,
    );
    const ok = await fetch(`${srv.base}/metrics`, {
      headers: { Authorization: "Bearer s3cret-token" },
    });
    assert.equal(ok.status, 200);
  } finally {
    await srv.close();
  }
});

// ── the handshake gate ─────────────────────────────────────────────────────────────────

test("originAllowed: no Origin = not a browser; a list is exact; an empty list means same-origin", () => {
  assert.equal(originAllowed(undefined, "x.test", []), true);
  assert.equal(originAllowed("https://game.test", "game.test", []), true, "same origin by Host");
  assert.equal(originAllowed("https://evil.test", "game.test", []), false);
  assert.equal(
    originAllowed("null", "game.test", []),
    false,
    "sandboxed iframes and file:// pages",
  );
  assert.equal(originAllowed("https://a.test", "game.test", ["https://a.test"]), true);
  assert.equal(
    originAllowed("https://game.test", "game.test", ["https://a.test"]),
    false,
    "a list replaces the same-origin rule",
  );
  assert.equal(
    originAllowed("https://a.test.evil.test", "x", ["https://a.test"]),
    false,
    "no prefix matching",
  );
});

test("a page on another site cannot open a WebSocket: 403 on the handshake, counted, nothing connected", async () => {
  const srv = await startApp({ ALLOWED_ORIGINS: "https://game.example" });
  try {
    assert.equal(await handshake(srv.wsUrl, "https://evil.example"), 403);
    assert.equal(await handshake(srv.wsUrl, "https://game.example"), "open");
    assert.equal(await handshake(srv.wsUrl), "open", "no Origin header: a script, not a browser");
    const text = await (await fetch(`${srv.base}/metrics`)).text();
    assert.equal(metric(text, "dogfight_rejections_total", '{reason="origin"}'), 1);
  } finally {
    await srv.close();
  }
});

test("with no ALLOWED_ORIGINS, only pages served by this same server may connect", async () => {
  const srv = await startApp();
  try {
    assert.equal(await handshake(srv.wsUrl, `http://127.0.0.1:${srv.port}`), "open");
    assert.equal(await handshake(srv.wsUrl, "http://evil.example"), 403);
  } finally {
    await srv.close();
  }
});

test("clientIp: X-Forwarded-For counts only for the trusted number of proxies, from the right", () => {
  const req = (xff: string | undefined, peer = "10.0.0.9") => ({
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
    socket: { remoteAddress: peer },
  });
  // the client invented "1.1.1.1"; our one proxy appended the address it actually saw
  assert.equal(clientIp(req("1.1.1.1, 203.0.113.7"), 1), "203.0.113.7");
  assert.equal(clientIp(req("1.1.1.1, 203.0.113.7"), 0), "10.0.0.9", "trust nobody: the TCP peer");
  assert.equal(
    clientIp(req("203.0.113.7"), 2),
    "10.0.0.9",
    "fewer entries than hops: fall back to the peer",
  );
  assert.equal(clientIp(req(undefined, "::ffff:192.0.2.1"), 0), "192.0.2.1");
});

test("a per-address cap: the third connection from one IP is refused with 429, and frees up on close", async () => {
  const srv = await startApp({ MAX_CONNECTIONS_PER_IP: "2" });
  try {
    const a = connect(srv.wsUrl);
    const b = connect(srv.wsUrl);
    await Promise.all([a.opened, b.opened]);
    assert.equal(srv.app.ws.connectionsFrom("127.0.0.1"), 2);
    assert.equal(await handshake(srv.wsUrl), 429);
    a.socket.close();
    await a.closed;
    assert.equal(await handshake(srv.wsUrl), "open");
    const text = await (await fetch(`${srv.base}/metrics`)).text();
    assert.equal(metric(text, "dogfight_rejections_total", '{reason="ip_limit"}'), 1);
    b.socket.close();
  } finally {
    await srv.close();
  }
});

// ── abuse ──────────────────────────────────────────────────────────────────────────────

test("a flood of broken frames costs the sender its connection — once; the rest is ignored, not parsed or logged", async () => {
  const lines: string[] = [];
  const log = createLogger({ stream: { write: (l: string) => void lines.push(l) } });
  const dir = await mkdtemp(join(tmpdir(), "dogfight-flood-"));
  const { createApp } = await import("../src/index.ts");
  const app = createApp(loadConfig({ PORT: "0", LOG_DIR: dir, CLIENT_DIST: dir }), log);
  const { port } = await app.listen();
  try {
    const c = connect(`ws://127.0.0.1:${port}/ws`);
    await c.opened;
    for (let i = 0; i < 1000; i++) c.send("{ this is not json");
    assert.equal((await c.closed).code, 4000);
    const warnings = lines
      .map((l): unknown => JSON.parse(l))
      .filter((e) => field(e, "msg") === "bad message");
    assert.equal(warnings.length, 1, "one warning, not a thousand");
    const text = await app.metrics.render();
    assert.equal(metric(text, "dogfight_rejections_total", '{reason="bad_message"}'), 1);
    assert.ok(metric(text, "dogfight_messages_in_total", '{type="invalid"}') >= 1);
  } finally {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close codes map to the reasons the metrics count", () => {
  assert.equal(rejectionFor(1000), null);
  assert.equal(rejectionFor(1001), "shutdown");
  assert.equal(rejectionFor(1008), "rate_limit");
  assert.equal(rejectionFor(1013), "slow_client");
  assert.equal(rejectionFor(4003), "join_timeout");
  assert.equal(rejectionFor(4004), "join_rejected");
  assert.equal(rejectionFor(4000), "bad_message");
  assert.equal(rejectionFor(1009), "bad_message");
});

// ── logs ───────────────────────────────────────────────────────────────────────────────

test("logs are one JSON object per line, with level and message; a child logger adds roomId/playerId", () => {
  const lines: string[] = [];
  const log = createLogger({
    stream: { write: (l: string) => void lines.push(l) },
    base: { version: "v1" },
  });
  log.child({ roomId: "belt-1", playerId: "p7" }).info("joined", { name: "Ace" });
  const entry: unknown = JSON.parse(lines[0] ?? "");
  assert.equal(field(entry, "level"), "info");
  assert.equal(field(entry, "msg"), "joined");
  assert.equal(field(entry, "roomId"), "belt-1");
  assert.equal(field(entry, "playerId"), "p7");
  assert.equal(field(entry, "name"), "Ace");
  assert.equal(field(entry, "version"), "v1");
  assert.equal(typeof field(entry, "time"), "number");
});

test("secrets never reach the log: password, token, dsn, authorization — at the top or one level down", () => {
  const lines: string[] = [];
  const log = createLogger({ stream: { write: (l: string) => void lines.push(l) } });
  log.info("config", {
    token: "tok-123",
    password: "hunter2",
    dsn: "https://key@sentry.example/1",
    headers: { authorization: "Bearer abc", cookie: "sid=1" },
    port: 3000,
  });
  const text = lines.join("");
  for (const secret of ["tok-123", "hunter2", "key@sentry", "Bearer abc", "sid=1"])
    assert.ok(!text.includes(secret), `${secret} leaked`);
  assert.ok(text.includes('"port":3000'), "ordinary fields stay");
});

test("LOG_LEVEL filters: at `warn`, info lines are not written", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "warn", stream: { write: (l: string) => void lines.push(l) } });
  log.info("quiet");
  log.warn("loud");
  assert.equal(lines.length, 1);
});

// ── config ─────────────────────────────────────────────────────────────────────────────

test("config: ALLOWED_ORIGINS is a list of origins, normalised; a wildcard or a path is refused at start-up", () => {
  const env = { LOG_DIR: tmpdir() };
  assert.deepEqual(
    loadConfig({ ...env, ALLOWED_ORIGINS: "https://a.test, http://localhost:5173/" })
      .allowedOrigins,
    ["https://a.test", "http://localhost:5173"],
  );
  assert.deepEqual(loadConfig(env).allowedOrigins, []);
  for (const bad of ["*", "https://a.test/path", "a.test", "ftp://a.test"])
    assert.throws(() => loadConfig({ ...env, ALLOWED_ORIGINS: bad }), ConfigError, bad);
});

test("config: the new limits are validated like the old ones", () => {
  const env = { LOG_DIR: tmpdir() };
  assert.equal(loadConfig(env).maxConnectionsPerIp, 20);
  assert.equal(loadConfig({ ...env, MAX_CONNECTIONS_PER_IP: "3" }).maxConnectionsPerIp, 3);
  assert.throws(() => loadConfig({ ...env, MAX_CONNECTIONS_PER_IP: "0" }), ConfigError);
  assert.throws(() => loadConfig({ ...env, LOG_LEVEL: "chatty" }), ConfigError);
  assert.throws(() => loadConfig({ ...env, TRUSTED_PROXY_HOPS: "-1" }), ConfigError);
});

// ── crashes ────────────────────────────────────────────────────────────────────────────

test("an uncaught exception or unhandled rejection is logged as fatal, with the stack, and the process exits non-zero", () => {
  const lines: string[] = [];
  const log = createLogger({ stream: { write: (l: string) => void lines.push(l) } });
  const exits: number[] = [];
  const bus = Object.assign(new EventEmitter(), {
    exit(code: number): void {
      exits.push(code);
    },
  });
  const fake: ProcessLike = bus;
  installCrashHandlers(log, fake);
  bus.emit("uncaughtException", new Error("boom"), "uncaughtException");
  bus.emit("unhandledRejection", new Error("lost promise"));
  assert.deepEqual(exits, [1, 1]);
  const [first, second] = lines.map((l): unknown => JSON.parse(l));
  assert.equal(field(first, "level"), "fatal");
  assert.match(String(field(first, "error")), /Error: boom\n\s+at /);
  assert.match(String(field(second, "error")), /lost promise/);
});

test("for real: a throw in a timer, and a rejected promise nobody awaited, each end the process with exit code 1 and a fatal line with the stack", async () => {
  const { spawnSync } = await import("node:child_process");
  const src = new URL("../src/", import.meta.url).href;
  const run = (body: string) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { installCrashHandlers } from "${src}crash.ts";
         import { createLogger } from "${src}logger.ts";
         installCrashHandlers(createLogger());
         ${body}
         setTimeout(() => console.log("still alive"), 500);`,
      ],
      { encoding: "utf8" },
    );
  for (const [body, message] of [
    ['setTimeout(() => { throw new Error("from a timer"); }, 10);', "from a timer"],
    ['Promise.reject(new Error("from a promise"));', "from a promise"],
  ] as const) {
    const result = run(body);
    assert.equal(result.status, 1, `${message}: exit code`);
    assert.ok(!result.stdout.includes("still alive"), "the process did not carry on");
    const entry: unknown = JSON.parse(result.stdout.trim().split("\n")[0] ?? "");
    assert.equal(field(entry, "level"), "fatal");
    assert.match(String(field(entry, "error")), new RegExp(`Error: ${message}\\n\\s+at `));
  }
});
