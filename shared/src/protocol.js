// The wire protocol, version 1. Used by the server to validate, by the client to build.
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
// "binary" (default; DataView frames, see codec/binary.js) or "json" (the same messages as
// text, kept for comparison). In JSON mode `input` and `ping` arrive as text frames and are
// validated here too.
//
// Nothing a client sends is trusted: `validate` checks size, JSON, version, type and the
// exact shape of every message, and says which close code the offender deserves.

import { NETSIM_LIMITS, validateInput } from "./input.js";

export const PROTOCOL_VERSION = 1;

export const CLOSE = Object.freeze({
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
});

/** Close codes after which reconnecting would only repeat the mistake. */
export function isFatalClose(code) {
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
export function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

const bad = (reason, code = CLOSE.BAD_MESSAGE) => ({ ok: false, code, reason });

function checkName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || name.length > NAME_MAX || hasControl(name)) return null;
  return name;
}

function checkFields(msg, allowed) {
  for (const key of Object.keys(msg)) {
    if (key !== "v" && key !== "type" && !allowed.includes(key)) return `unexpected field "${key}"`;
  }
  return null;
}

const SHAPES = {
  join(msg) {
    const extra = checkFields(msg, ["room", "name", "codec"]);
    if (extra) return bad(extra);
    if (typeof msg.room !== "string" || !ROOM_ID.test(msg.room)) return bad("invalid room id");
    const name = checkName(msg.name);
    if (!name) return bad(`name must be 1–${NAME_MAX} printable characters`);
    const codec = msg.codec ?? "binary";
    if (codec !== "binary" && codec !== "json") return bad('codec must be "binary" or "json"');
    return { ok: true, msg: { type: "join", room: msg.room, name, codec } };
  },
  chat(msg) {
    const extra = checkFields(msg, ["text"]);
    if (extra) return bad(extra);
    if (typeof msg.text !== "string") return bad("text must be a string");
    const text = msg.text.trim();
    if (!text || text.length > CHAT_MAX || hasControl(text)) {
      return bad(`text must be 1–${CHAT_MAX} printable characters`);
    }
    return { ok: true, msg: { type: "chat", text } };
  },
  leave(msg) {
    const extra = checkFields(msg, []);
    if (extra) return bad(extra);
    return { ok: true, msg: { type: "leave" } };
  },
  // JSON-codec game messages
  input(msg) {
    const extra = checkFields(msg, ["seq", "tick", "thrust", "turn", "fire"]);
    if (extra) return bad(extra);
    const r = validateInput(msg);
    return r.ok ? { ok: true, msg: { type: "input", ...r.input } } : bad(r.reason);
  },
  ping(msg) {
    const extra = checkFields(msg, ["t"]);
    if (extra) return bad(extra);
    if (!Number.isFinite(msg.t)) return bad("t must be a number");
    return { ok: true, msg: { type: "ping", t: msg.t } };
  },
  netsim(msg) {
    const extra = checkFields(msg, ["latency", "jitter", "drop"]);
    if (extra) return bad(extra);
    for (const key of ["latency", "jitter", "drop"]) {
      const v = msg[key];
      if (!Number.isFinite(v) || v < 0 || v > NETSIM_LIMITS[key]) {
        return bad(`${key} must be a number in 0–${NETSIM_LIMITS[key]}`);
      }
    }
    return {
      ok: true,
      msg: { type: "netsim", latency: msg.latency, jitter: msg.jitter, drop: msg.drop },
    };
  },
};

/** UTF-8 length of a string without Buffer/TextEncoder (this file must run in a browser too). */
export function utf8Length(text) {
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

/**
 * @param {string|Uint8Array} raw  one text frame (`ws` hands the server a Buffer, a Uint8Array)
 * @returns {{ok: true, msg: object} | {ok: false, code: number, reason: string}}
 */
export function validate(raw, { maxBytes = 2048 } = {}) {
  const size = typeof raw === "string" ? utf8Length(raw) : raw.length;
  if (size > maxBytes) return bad(`message is ${size} bytes, limit is ${maxBytes}`, CLOSE.TOO_BIG);

  let msg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return bad("not valid JSON");
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return bad("message must be a JSON object");
  }
  if (msg.v !== PROTOCOL_VERSION) return bad(`unsupported protocol version ${msg.v}`);
  if (typeof msg.type !== "string") return bad("missing type");
  if (!Object.hasOwn(SHAPES, msg.type))
    return bad(`unknown type "${msg.type}"`, CLOSE.UNKNOWN_TYPE);
  return SHAPES[msg.type](msg);
}

const frame = (type, fields) => ({ v: PROTOCOL_VERSION, type, ...fields });

export const toClient = {
  joined: (fields) => frame("joined", fields),
  roster: (players) => frame("roster", { players }),
  chat: ({ from, text, t }) => frame("chat", { from, text, t }),
  error: (code, message) => frame("error", { code, message }),
};
