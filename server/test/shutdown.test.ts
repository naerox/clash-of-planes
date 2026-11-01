import { test } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, hello, openRoom } from "./helpers.ts";

const field = (m: unknown, key: string): unknown =>
  typeof m === "object" && m !== null ? Object.entries(m).find(([k]) => k === key)?.[1] : undefined;

const ENTRY = join(import.meta.dirname, "../src/index.ts");

/** Starts the real server as a child process on a random port; resolves once it logs "listening". */
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/"msg":"listening","url":"(http:\/\/[^"]+)"/);
      if (m?.[1]) resolve(m[1]);
    });
    void exited.then(({ code }) => reject(new Error(`exited early with ${code}: ${err}`)));
  });
  return { child, ready, exited, output: () => out };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal}: sockets get 1001, the log is flushed, the process exits with code 0`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "dogfight-shutdown-"));
    const srv = start({ PORT: "0", HOST: "127.0.0.1", LOG_DIR: dir, CLIENT_DIST: dir });
    try {
      const base = await srv.ready;
      const room = await openRoom(base, { name: "Bye" });
      const c = connect(base.replace("http", "ws") + "/ws");
      await c.opened;
      c.send(hello(room.id, "Ace"));
      await c.nextOf("joined");

      srv.child.kill(signal);
      assert.equal((await c.closed).code, 1001);
      assert.deepEqual(await srv.exited, { code: 0, signal: null });

      const [file] = await readdir(dir);
      assert.ok(file, "the match log exists");
      const events = (await readFile(join(dir, file), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l): unknown => JSON.parse(l));
      assert.equal(field(events.at(0), "type"), "room_opened");
      assert.equal(
        field(events.at(-1), "type"),
        "room_closed",
        "the log has its final line: it was flushed before exit",
      );
      assert.match(srv.output(), /"msg":"bye"/);
    } finally {
      srv.child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("an invalid PORT makes the process refuse to start (exit code 2) and say why", async () => {
  const srv = start({ PORT: "eighty", LOG_DIR: tmpdir() });
  srv.ready.catch(() => {});
  const { code } = await srv.exited;
  assert.equal(code, 2);
});
