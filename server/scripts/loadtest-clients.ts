// One OS process full of headless clients, for scripts/loadtest.ts. Each client is a bare
// WebSocket that joins a room and sends the same 12-byte binary input a browser would, 30 times
// a second, flying a scripted path; it does NOT decode what comes back (it only counts bytes),
// so the machine's CPU goes to the server under test and not to the measuring tool.
//
//   node scripts/loadtest-clients.ts --url=ws://127.0.0.1:3000/ws --rooms=a,b --count=32 --per-room=8 --seconds=25

import { WebSocket } from "ws";
import { binaryCodec, seq, tick } from "@dogfight/shared";
import { parseArgs, sleep } from "./common.ts";

const args = parseArgs();
const url = args.url ?? "ws://127.0.0.1:3000/ws";
const rooms = (args.rooms ?? "").split(",").filter(Boolean);
const COUNT = Number(args.count ?? 8);
const PER_ROOM = Number(args["per-room"] ?? 8);
const SECONDS = Number(args.seconds ?? 20);
const offset = Number(args.offset ?? 0); // global index of this process's first client

let bytesIn = 0;
let joinedCount = 0;
let closed = 0;
const timers: NodeJS.Timeout[] = [];

function client(index: number): void {
  const room = rooms[Math.floor((offset + index) / PER_ROOM) % rooms.length];
  if (!room) return;
  const ws = new WebSocket(url);
  let n = 0;
  ws.on("open", () => {
    ws.send(
      JSON.stringify({ v: 1, type: "join", room, name: `c${offset + index}`, codec: "binary" }),
    );
  });
  ws.on("message", (data: Buffer, isBinary) => {
    bytesIn += data.length;
    if (!isBinary && joinedCount < COUNT && data.includes('"joined"')) {
      joinedCount++;
      // a scripted path: thrust, a turn that flips every second (phase differs per client), fire often
      const phase = index * 7;
      const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        n++;
        const flip = Math.floor((n + phase) / 30) % 2 === 0;
        ws.send(
          binaryCodec.encode({
            type: "input",
            seq: seq(n),
            tick: tick(0),
            thrust: true,
            turn: flip ? 1 : -1,
            fire: n % 5 === 0,
          }),
        );
      }, 1000 / 30);
      timers.push(timer);
    }
  });
  ws.on("error", () => {});
  ws.on("close", () => closed++);
}

for (let i = 0; i < COUNT; i++) {
  client(i);
  if (i % 8 === 7) await sleep(20); // ramp: never all handshakes in the same millisecond
}
await sleep(SECONDS * 1000);
for (const t of timers) clearInterval(t);
process.stdout.write(
  `${JSON.stringify({ offset, count: COUNT, joined: joinedCount, closedEarly: closed, bytesIn })}\n`,
);
process.exit(0);
