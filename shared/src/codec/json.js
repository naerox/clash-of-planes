// The same logical messages as text. Kept behind a flag (`?codec=json`) purely so there is
// something to compare the binary format with: it is bigger, and slower to turn into numbers
// and back.

import { PROTOCOL_VERSION } from "../protocol.js";
import { validateInput } from "../input.js";
import { CodecError } from "./errors.js";

const KNOWN = new Set(["input", "snapshot", "ping", "pong"]);

export const jsonCodec = {
  name: "json",
  binary: false,

  /** @returns {string} */
  encode(message) {
    if (!KNOWN.has(message.type)) throw new CodecError(`cannot encode "${message.type}"`);
    return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
  },

  /** @param {string} text @throws {CodecError} */
  decode(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new CodecError("not valid JSON");
    }
    if (obj === null || typeof obj !== "object") throw new CodecError("not an object");
    if (obj.v !== PROTOCOL_VERSION) throw new CodecError(`unsupported version ${obj.v}`);
    const { v, ...message } = obj;
    void v;
    if (!KNOWN.has(message.type)) throw new CodecError(`unknown type "${message.type}"`);
    if (message.type === "input") {
      const r = validateInput(message);
      if (!r.ok) throw new CodecError(`invalid input: ${r.reason}`);
      return { type: "input", ...r.input };
    }
    if (message.type === "snapshot") {
      for (const key of ["ships", "bullets", "asteroids", "pickups", "events"]) {
        if (!Array.isArray(message[key])) throw new CodecError(`snapshot.${key} must be an array`);
      }
    }
    return message;
  },
};
