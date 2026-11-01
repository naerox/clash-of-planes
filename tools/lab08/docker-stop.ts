// "Prove it to yourself" 1: `docker stop` while players are connected.
//
//   docker run -d --name game --network=host -e PORT=3100 dogfight:test
//   node tools/lab08/docker-stop.ts --container=game --url=http://127.0.0.1:3100
//
// Two WebSocket clients join a room; then `docker stop` is timed. What must happen: both clients
// receive the server's `shutdown` message and a close frame with code 1001, the container exits
// with code 0, and all of it takes well under the 10 s after which Docker sends SIGKILL.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k = "", v = "1"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const container = args.container ?? "game";
const base = args.url ?? "http://127.0.0.1:3100";
const label = args.label ?? "docker-stop";

const room = z.object({ id: z.string() }).parse(
  await (
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "stop-test" }),
    })
  ).json(),
);

interface Seen {
  name: string;
  sawShutdownMessage: boolean;
  closeCode: number | null;
  closedAfterMs: number | null;
}
const seen: Seen[] = [];
let stoppedAt = 0;

function join_(name: string): Promise<void> {
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const entry: Seen = { name, sawShutdownMessage: false, closeCode: null, closedAfterMs: null };
  seen.push(entry);
  socket.on("message", (data, isBinary) => {
    if (!isBinary && Buffer.isBuffer(data) && data.toString().includes('"type":"shutdown"'))
      entry.sawShutdownMessage = true;
  });
  socket.on("close", (code) => {
    entry.closeCode = code;
    entry.closedAfterMs = Math.round(performance.now() - stoppedAt);
  });
  socket.on("error", () => {});
  return new Promise((resolve) => {
    socket.on("open", () => {
      socket.send(JSON.stringify({ v: 1, type: "join", room: room.id, name, codec: "binary" }));
      setTimeout(resolve, 500);
    });
  });
}
await join_("alice");
await join_("bob");

stoppedAt = performance.now();
// asynchronous on purpose: a blocking call would freeze THIS process's event loop, and the clients
// here could not answer the server's close frame until `docker stop` had already returned
await promisify(execFile)("docker", ["stop", container]);
const totalMs = Math.round(performance.now() - stoppedAt);
await new Promise((r) => setTimeout(r, 200));

const exitCode = Number(
  execFileSync("docker", ["inspect", container, "--format", "{{.State.ExitCode}}"]).toString(),
);
const logs = execFileSync("docker", ["logs", "--tail", "6", container], {
  stdio: ["ignore", "pipe", "pipe"],
}).toString();
const result = {
  container,
  totalMs,
  exitCode,
  clients: seen,
  lastLogLines: logs.trim().split("\n"),
};
console.log(JSON.stringify(result, null, 2));
mkdirSync(join(import.meta.dirname, "../../docs/lab-08"), { recursive: true });
writeFileSync(
  join(import.meta.dirname, `../../docs/lab-08/${label}.json`),
  `${JSON.stringify(result, null, 2)}\n`,
);
const ok =
  exitCode === 0 &&
  totalMs < 9000 &&
  seen.every((c) => c.closeCode === 1001 && c.sawShutdownMessage);
if (!ok) process.exit(1);
