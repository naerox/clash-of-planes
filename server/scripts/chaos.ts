// The garbage-flood chaos test, with numbers (the vitest version in server/test/chaos.test.ts
// asserts the behaviour; this one measures what it costs).
//
//   node server/scripts/chaos.ts [--seconds=10] [--attackers=6]
//
// One real server process. A "victim" room holds 8 bots, so its tick has real work to do. Then:
//   phase 1  baseline         nobody attacks; read the victim room's tick time and the traffic rates
//   phase 2  attack           N attackers loop forever: connect → join → fire ~1000 garbage frames a
//                             second → get cut off → reconnect at once
// If the isolation is real, the victim room's tick p99 in phase 2 is as good as in phase 1, and the
// attack shows up where it should: in `dogfight_rejections_total`, not in the tick.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { parseArgs, startServer } from "./common.ts";

const args = parseArgs();
const SECONDS = Number(args.seconds ?? 10);
const ATTACKERS = Number(args.attackers ?? 6);
const ROOT = join(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "dogfight-chaos-"));
const { child, base } = await startServer(join(ROOT, "server/src/index.ts"), {
  PORT: "0",
  HOST: "127.0.0.1",
  LOG_DIR: dir,
  CLIENT_DIST: dir,
  LOG_LEVEL: "info", // startServer finds the port in the "listening" line
  NODE_ENV: "development",
  MAX_ROOMS: "20",
  MAX_PLAYERS_PER_ROOM: "16",
  MAX_CONNECTIONS_PER_IP: "50", // the default is 20: the attack should meet the real limit, not a test-sized one
});
const wsBase = base.replace("http", "ws");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const post = async (path: string, body: unknown): Promise<unknown> =>
  (
    await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
const victim = z
  .object({ id: z.string() })
  .parse(await post("/api/rooms", { name: "Victim", maxPlayers: 16 }));
const target = z
  .object({ id: z.string() })
  .parse(await post("/api/rooms", { name: "Target", maxPlayers: 16 }));
await post(`/api/rooms/${victim.id}/bots`, { count: 8 });

// a real player in the victim room, so there is somebody to measure for
const bystander = new WebSocket(`${wsBase}/ws`);
let received = 0;
bystander.on("message", () => received++);
bystander.on("error", () => {});
await new Promise<void>((r) => bystander.on("open", () => r()));
bystander.send(
  JSON.stringify({ v: 1, type: "join", room: victim.id, name: "Bystander", codec: "binary" }),
);
// …and one quiet player in the room the attackers hit: a room is deleted when its last human leaves,
// and the attackers (who are cut off one after another) would otherwise take the room with them
const holder = new WebSocket(`${wsBase}/ws`);
holder.on("error", () => {});
await new Promise<void>((r) => holder.on("open", () => r()));
holder.send(
  JSON.stringify({ v: 1, type: "join", room: target.id, name: "Holder", codec: "binary" }),
);
await sleep(4000); // let the JIT warm up: a baseline taken on cold code would flatter the attack

const metricsSchema = (text: string) => {
  const read = (name: string, labels = ""): number =>
    Number(
      text
        .split("\n")
        .find((l) => l.startsWith(`${name}${labels} `))
        ?.split(" ")
        .at(-1) ?? 0,
    );
  return {
    messagesIn: read("dogfight_messages_in_total", '{type="invalid"}'),
    bytesIn: read("dogfight_bytes_in_total"),
    bytesOut: read("dogfight_bytes_out_total"),
    messagesOut: read("dogfight_messages_out_total"),
    rejectBad: read("dogfight_rejections_total", '{reason="bad_message"}'),
    rejectIp: read("dogfight_rejections_total", '{reason="ip_limit"}'),
    connections: read("dogfight_connections_total"),
    elu: read("dogfight_event_loop_utilization"),
  };
};
const stats = z.object({
  matches: z.array(
    z.object({
      room: z.string(),
      tickDurationMs: z.object({
        mean: z.number(),
        p99: z.number(),
        max: z.number(),
        n: z.number(),
      }),
      tickIntervalMs: z.object({ p99: z.number(), max: z.number() }),
    }),
  ),
});
const sample = async () => {
  const s = stats.parse(await (await fetch(`${base}/api/stats`)).json());
  const m = metricsSchema(await (await fetch(`${base}/metrics`)).text());
  const v = s.matches.find((x) => x.room === victim.id);
  return { at: performance.now(), victim: v, metrics: m };
};

/** How the attackers were ended: close code → how many times. */
const closeCodes = new Map<number, number>();

async function phase(label: string, attack: boolean) {
  const stop = { now: false };
  const attackLoops = attack
    ? Array.from({ length: ATTACKERS }, async () => {
        while (!stop.now) {
          const ws = new WebSocket(`${wsBase}/ws`);
          ws.on("error", () => {});
          await new Promise<void>((resolve) => {
            ws.on("open", () => {
              ws.send(
                JSON.stringify({
                  v: 1,
                  type: "join",
                  room: target.id,
                  name: `Atk${Math.random().toString(36).slice(2, 8)}`,
                  codec: "binary",
                }),
              );
              // ~1000 garbage frames per second until the server hangs up on us
              const t = setInterval(() => {
                for (let i = 0; i < 10 && ws.readyState === 1; i++) ws.send("{ garbage");
              }, 10);
              ws.on("close", (code) => {
                closeCodes.set(code, (closeCodes.get(code) ?? 0) + 1);
                clearInterval(t);
                resolve();
              });
            });
            ws.on("close", () => resolve());
          });
        }
      })
    : [];
  await sleep(500);
  const a = await sample();
  await sleep(SECONDS * 1000);
  const b = await sample();
  stop.now = true;
  await Promise.all(attackLoops);
  const secs = (b.at - a.at) / 1000;
  const rate = (k: keyof typeof a.metrics): number =>
    Math.round(((b.metrics[k] - a.metrics[k]) / secs) * 10) / 10;
  return {
    phase: label,
    seconds: Math.round(secs),
    victimTick: b.victim?.tickDurationMs,
    victimInterval: b.victim?.tickIntervalMs,
    perSecond: {
      invalidFramesIn: rate("messagesIn"),
      bytesIn: rate("bytesIn"),
      bytesOut: rate("bytesOut"),
      messagesOut: rate("messagesOut"),
      rejectedBadMessage: rate("rejectBad"),
      rejectedIpLimit: rate("rejectIp"),
      connectionsAccepted: rate("connections"),
    },
    eventLoopUtilization: b.metrics.elu,
  };
}

const baseline = await phase("baseline", false);
const attack = await phase("attack", true);
const result = {
  attackers: ATTACKERS,
  bystanderMessages: received,
  attackerCloseCodes: Object.fromEntries(closeCodes),
  baseline,
  attack,
};
console.log(JSON.stringify(result, null, 2));
const out = join(ROOT, "docs/lab-08");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "chaos.json"), `${JSON.stringify(result, null, 2)}\n`);
bystander.close();
holder.close();
child.kill("SIGTERM");
