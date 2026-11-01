// The wire protocol, version 1 — as Zod schemas. The schema is the single source of truth:
// the same object validates what arrives at runtime AND (through `z.infer`) gives the compiler
// the TypeScript type, so the two cannot drift apart. Used by the server to validate, by the
// client to validate what the server sends and to build its own messages.
//
// CONTROL messages are always JSON text frames, `{ v, type, ...fields }`:
//
//   client → server   join   { room, name, codec? }  first message, within JOIN_TIMEOUT_MS
//                     chat   { text }
//                     leave  {}
//                     netsim { latency, jitter, drop }   artificial lag for THIS connection
//   server → client   joined { room, you, shipId, players, seed, tickRate, tick, codec }
//                     roster { players }               someone joined or left
//                     chat   { from, text, t }
//                     error  { code, message }
//
// GAME messages (input, ping up; snapshot, pong down) go through a CODEC chosen in `join`:
// "binary" (default; DataView frames, see codec/binary.ts) or "json" (the same messages as
// text, kept for comparison). In JSON mode `input` and `ping` arrive as text frames and are
// validated here too.
//
// Nothing a client sends is trusted. TypeScript types are erased at runtime, so `msg: ClientMessage`
// proves nothing about bytes from a socket: `parseClientMessage` takes `unknown`, checks size,
// JSON, version, type and the exact shape (unknown fields are rejected), and says which close
// code the offender deserves. It never throws.
//
// The schemas describe the message WITHOUT the `v` field: the envelope (`v`) is checked once,
// by the parse functions, and added once, by the builders and the codecs.

import { z } from "zod";
import { entityId, seq, shotSeq, tick } from "./brand.ts";
import { MAX_SEQ, NETSIM_LIMITS } from "./input.ts";
import type { SimEvent } from "./sim/events.ts";
import type { ShipState } from "./sim/ship.ts";

export const PROTOCOL_VERSION = 1;

export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001, // server is shutting down — the client should reconnect
  UNSUPPORTED: 1003, // a binary frame the codec cannot read
  POLICY: 1008, // rate limit exceeded
  TOO_BIG: 1009, // message over MAX_MESSAGE_BYTES
  TRY_LATER: 1013, // slow client, dropped to protect the server
  BAD_MESSAGE: 4000, // not JSON / wrong version / wrong shape
  UNKNOWN_TYPE: 4001,
  NOT_JOINED: 4002, // anything but `join` before joining
  JOIN_TIMEOUT: 4003,
  JOIN_REJECTED: 4004, // no such room, room full, name taken
  ALREADY_JOINED: 4005,
} as const;

/** Close codes after which reconnecting would only repeat the mistake. */
export function isFatalClose(code: number): boolean {
  return (
    code === CLOSE.UNSUPPORTED ||
    code === CLOSE.POLICY ||
    code === CLOSE.TOO_BIG ||
    (code >= 4000 && code < 4100)
  );
}

export const NAME_MAX = 16;
export const CHAT_MAX = 200;
const ROOM_ID = /^[a-z0-9-]{1,48}$/;

/** True if `s` has a C0 control character or DEL (a regex for that trips no-control-regex). */
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** UTF-8 length of a string without Buffer/TextEncoder (this file must run in a browser too). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // a surrogate pair is one 4-byte code point
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// ── building blocks ──────────────────────────────────────────────────────────────────

export const CODEC_NAMES = ["binary", "json"] as const;
export type CodecName = (typeof CODEC_NAMES)[number];

const entityIdSchema = z.number().int().min(0).max(0xffff).transform(entityId);
const tickSchema = z.number().int().min(0).max(MAX_SEQ).transform(tick);
const seqSchema = z.number().int().min(0).max(MAX_SEQ).transform(seq); // 0 = nothing acknowledged yet
const inputSeqSchema = z.number().int().min(1).max(MAX_SEQ).transform(seq);
const shotSeqSchema = z.number().int().min(0).max(0xffff).transform(shotSeq);
const turnSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const codecSchema = z.enum(CODEC_NAMES);

const printable = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${what} must not be empty`)
    .max(max, `${what} must be at most ${max} characters`)
    .refine((s) => !hasControl(s), `${what} must not contain control characters`);

// ── client → server ──────────────────────────────────────────────────────────────────

export const inputSchema = z.strictObject({
  type: z.literal("input"),
  seq: inputSeqSchema,
  tick: tickSchema,
  thrust: z.boolean(),
  turn: turnSchema,
  fire: z.boolean(),
});

export const pingSchema = z.strictObject({ type: z.literal("ping"), t: z.number() });

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("join"),
    room: z.string().regex(ROOM_ID, "invalid room id"),
    name: printable("name", NAME_MAX),
    codec: codecSchema.default("binary"),
  }),
  z.strictObject({ type: z.literal("chat"), text: printable("text", CHAT_MAX) }),
  z.strictObject({ type: z.literal("leave") }),
  inputSchema,
  pingSchema,
  z.strictObject({
    type: z.literal("netsim"),
    latency: z.number().min(0).max(NETSIM_LIMITS.latency),
    jitter: z.number().min(0).max(NETSIM_LIMITS.jitter),
    drop: z.number().min(0).max(NETSIM_LIMITS.drop),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type InputMessage = z.infer<typeof inputSchema>;
export type PingMessage = z.infer<typeof pingSchema>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

// ── snapshots (server → client, in either codec) ─────────────────────────────────────

const simEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("fired"),
    shooterId: entityIdSchema,
    x: z.number(),
    y: z.number(),
  }),
  z.strictObject({
    type: z.literal("hit"),
    target: z.enum(["ship", "asteroid"]),
    targetId: entityIdSchema,
    x: z.number(),
    y: z.number(),
    damage: z.number(),
  }),
  z.strictObject({
    type: z.literal("exploded"),
    kind: z.enum(["ship", "asteroid"]),
    id: entityIdSchema,
    x: z.number(),
    y: z.number(),
    radius: z.number(),
  }),
]);

const shipStateSchema = z.strictObject({
  id: entityIdSchema,
  x: z.number(),
  y: z.number(),
  vx: z.number(),
  vy: z.number(),
  angle: z.number(),
  hp: z.number(),
  cooldown: z.number(),
  rapid: z.number(),
  respawn: z.number(),
  score: z.number(),
  thrusting: z.boolean(),
});

/**
 * `SimEvent` and `ShipState` are owned by the simulation; these schemas must describe EXACTLY
 * the same types. `ZodType<SimEvent>` alone would not do: a schema that accepts only SOME of the
 * events is still assignable to it, so a new event type the schema forgot would compile. The
 * constants below only compile while the two types are mutually assignable.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const eventSchemaIsExact: Exact<z.infer<typeof simEventSchema>, SimEvent> = true;
export const shipStateSchemaIsExact: Exact<z.infer<typeof shipStateSchema>, ShipState> = true;

// Every entity in a snapshot says what it is in `kind`, like the live entities do.
const shipSnapSchema = z.strictObject({
  kind: z.literal("ship"),
  id: entityIdSchema,
  x: z.number(),
  y: z.number(),
  angle: z.number(),
  hp: z.number(),
  thrusting: z.boolean(),
  dead: z.boolean(),
  rapid: z.boolean(),
  score: z.number(),
});
const bulletSnapSchema = z.strictObject({
  kind: z.literal("bullet"),
  id: entityIdSchema,
  owner: entityIdSchema,
  x: z.number(),
  y: z.number(),
  seq: shotSeqSchema,
});
const asteroidSnapSchema = z.strictObject({
  kind: z.literal("asteroid"),
  id: entityIdSchema,
  x: z.number(),
  y: z.number(),
  angle: z.number(),
  radius: z.number(),
  hunter: z.boolean(),
});
const pickupSnapSchema = z.strictObject({
  kind: z.literal("pickup"),
  id: entityIdSchema,
  x: z.number(),
  y: z.number(),
  variant: z.enum(["shield", "rapid"]),
});

export const snapshotSchema = z.strictObject({
  type: z.literal("snapshot"),
  tick: tickSchema,
  ack: seqSchema,
  you: shipStateSchema.nullable(),
  ships: z.array(shipSnapSchema),
  bullets: z.array(bulletSnapSchema),
  asteroids: z.array(asteroidSnapSchema),
  pickups: z.array(pickupSnapSchema),
  events: z.array(simEventSchema),
});

export const pongSchema = z.strictObject({
  type: z.literal("pong"),
  t: z.number(),
  tick: tickSchema,
});

export type SnapshotMessage = z.infer<typeof snapshotSchema>;
export type ShipSnap = SnapshotMessage["ships"][number];
export type BulletSnap = SnapshotMessage["bullets"][number];
export type AsteroidSnap = SnapshotMessage["asteroids"][number];
export type PickupSnap = SnapshotMessage["pickups"][number];
export type SnapshotEntity = ShipSnap | BulletSnap | AsteroidSnap | PickupSnap;
export type PongMessage = z.infer<typeof pongSchema>;

/** Everything a codec carries: the game messages, in both directions. */
export const gameMessageSchema = z.discriminatedUnion("type", [
  inputSchema,
  pingSchema,
  snapshotSchema,
  pongSchema,
]);
export type GameMessage = z.infer<typeof gameMessageSchema>;

// ── server → client control messages ─────────────────────────────────────────────────

const rosterEntrySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  shipId: entityIdSchema.nullable(),
});

export const roomInfoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  players: z.number().int(),
  maxPlayers: z.number().int(),
  arena: z.strictObject({
    asteroids: z.number().optional(),
    hunters: z.number().optional(),
    asteroidSpeed: z.tuple([z.number(), z.number()]).readonly().optional(),
  }),
});

/** `GET /api/rooms`. */
export const roomListSchema = z.strictObject({ rooms: z.array(roomInfoSchema) });

export const serverControlSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("joined"),
    room: roomInfoSchema,
    you: z.string(),
    shipId: entityIdSchema.nullable(),
    players: z.array(rosterEntrySchema),
    seed: z.number().int(),
    tickRate: z.number(),
    tick: tickSchema,
    codec: codecSchema,
  }),
  z.strictObject({ type: z.literal("roster"), players: z.array(rosterEntrySchema) }),
  z.strictObject({
    type: z.literal("chat"),
    from: z.strictObject({ id: z.string(), name: z.string() }),
    text: z.string(),
    t: z.number(),
  }),
  z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

export type ServerControl = z.infer<typeof serverControlSchema>;
export type ServerControlOf<T extends ServerControl["type"]> = Extract<ServerControl, { type: T }>;
export type JoinedMessage = ServerControlOf<"joined">;
export type RosterEntry = z.infer<typeof rosterEntrySchema>;
export type RoomInfo = z.infer<typeof roomInfoSchema>;

/** Everything the server can put on a socket, once the codec is out of the way. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  ...serverControlSchema.options,
  snapshotSchema,
  pongSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ── parsing ──────────────────────────────────────────────────────────────────────────

export type ParseResult<T> =
  | { readonly ok: true; readonly msg: T }
  | { readonly ok: false; readonly code: number; readonly reason: string };

const bad = (reason: string, code: number = CLOSE.BAD_MESSAGE): ParseResult<never> => ({
  ok: false,
  code,
  reason,
});

function describeIssues(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid message";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Unwraps `{ v, type, ...rest }`: checks `v` and returns the rest. Never throws. */
function openEnvelope(text: string): ParseResult<Record<string, unknown> & { type: string }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad("not valid JSON");
  }
  if (!isRecord(value)) return bad("message must be a JSON object");
  const { v, ...rest } = value;
  if (v !== PROTOCOL_VERSION) return bad(`unsupported protocol version ${String(v)}`);
  const type = rest.type;
  if (typeof type !== "string") return bad("missing type");
  return { ok: true, msg: { ...rest, type } };
}

const CLIENT_TYPES: ReadonlySet<string> = new Set(
  clientMessageSchema.options.map((o) => o.shape.type.value),
);

const GAME_TYPES: ReadonlySet<string> = new Set(
  gameMessageSchema.options.map((o) => o.shape.type.value),
);

/**
 * The only door from "bytes on a socket" to `ClientMessage`. `raw` is `unknown` on purpose:
 * `ws` hands over a Buffer, but the compiler cannot know that, and neither can a hostile peer
 * be made to send one.
 */
export function parseClientMessage(
  raw: unknown,
  { maxBytes = 2048 }: { maxBytes?: number } = {},
): ParseResult<ClientMessage> {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else return bad("unsupported frame", CLOSE.UNSUPPORTED);
  const size = typeof raw === "string" ? utf8Length(raw) : raw.length;
  if (size > maxBytes) return bad(`message is ${size} bytes, limit is ${maxBytes}`, CLOSE.TOO_BIG);

  const opened = openEnvelope(text);
  if (!opened.ok) return opened;
  if (!CLIENT_TYPES.has(opened.msg.type)) {
    return bad(`unknown type "${opened.msg.type}"`, CLOSE.UNKNOWN_TYPE);
  }
  const parsed = clientMessageSchema.safeParse(opened.msg);
  return parsed.success ? { ok: true, msg: parsed.data } : bad(describeIssues(parsed.error));
}

/**
 * The client's counterpart: any JSON text frame from the server — a control message (joined,
 * roster, chat, error) or, on a JSON-codec connection, a snapshot or a pong.
 */
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  if (typeof raw !== "string") return bad("server frames are text");
  const opened = openEnvelope(raw);
  if (!opened.ok) return opened;
  const parsed = serverMessageSchema.safeParse(opened.msg);
  return parsed.success ? { ok: true, msg: parsed.data } : bad(describeIssues(parsed.error));
}

/** The control messages only (what a connection that uses the binary codec receives as text). */
export function parseServerControl(raw: unknown): ParseResult<ServerControl> {
  if (typeof raw !== "string") return bad("server frames are text");
  const opened = openEnvelope(raw);
  if (!opened.ok) return opened;
  const parsed = serverControlSchema.safeParse(opened.msg);
  return parsed.success ? { ok: true, msg: parsed.data } : bad(describeIssues(parsed.error));
}

/** For the JSON codec: a game message (`input`, `ping`, `snapshot`, `pong`) from text. */
export function parseGameMessage(text: string): ParseResult<GameMessage> {
  const opened = openEnvelope(text);
  if (!opened.ok) return opened;
  if (!GAME_TYPES.has(opened.msg.type)) {
    return bad(`unknown type "${opened.msg.type}"`, CLOSE.UNKNOWN_TYPE);
  }
  const parsed = gameMessageSchema.safeParse(opened.msg);
  return parsed.success ? { ok: true, msg: parsed.data } : bad(describeIssues(parsed.error));
}

// ── building (server → client) ───────────────────────────────────────────────────────

export type WithVersion<T> = T & { readonly v: typeof PROTOCOL_VERSION };

export const toClient = {
  joined: (fields: JoinedMessage): WithVersion<JoinedMessage> => ({
    v: PROTOCOL_VERSION,
    ...fields,
  }),
  roster: (players: RosterEntry[]): WithVersion<ServerControlOf<"roster">> => ({
    v: PROTOCOL_VERSION,
    type: "roster",
    players,
  }),
  chat: ({
    from,
    text,
    t,
  }: Omit<ServerControlOf<"chat">, "type">): WithVersion<ServerControlOf<"chat">> => ({
    v: PROTOCOL_VERSION,
    type: "chat",
    from,
    text,
    t,
  }),
  error: (code: string, message: string): WithVersion<ServerControlOf<"error">> => ({
    v: PROTOCOL_VERSION,
    type: "error",
    code,
    message,
  }),
};
