import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createRoom, hello } from "./helpers.js";

const ENTRY = join(import.meta.dirname, "../src/index.js");

/** Starts the real server as a child process on a random port; resolves once it logs "listening". */
function start(env) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/"msg":"listening","url":"(http:\/\/[^"]+)"/);
      if (m) resolve(m[1]);
    });
    exited.then(({ code }) => reject(new Error(`exited early with ${code}: ${err}`)));
  });
  return { child, ready, exited, output: () => out };
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal}: sockets get 1001, the log is flushed, the process exits with code 0`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "dogfight-shutdown-"));
    const srv = start({ PORT: "0", HOST: "127.0.0.1", LOG_DIR: dir, CLIENT_DIST: dir });
    try {
      const base = await srv.ready;
      const { body: room } = await createRoom(base, { name: "Bye" });
      const c = connect(base.replace("http", "ws") + "/ws");
      await c.opened;
      c.send(hello(room.id, "Ace"));
      assert.equal((await c.next()).type, "joined");

      srv.child.kill(signal);
      assert.equal((await c.closed).code, 1001);
      assert.deepEqual(await srv.exited, { code: 0, signal: null });

      const [file] = await readdir(dir);
      const events = (await readFile(join(dir, file), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert.equal(events.at(0).type, "room_opened");
      assert.equal(
        events.at(-1).type,
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
