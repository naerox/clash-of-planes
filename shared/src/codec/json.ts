// The same logical messages as text. Kept behind a flag (`?codec=json`) purely so there is
// something to compare the binary format with: it is bigger, and slower to turn into numbers
// and back. Decoding goes through the Zod schemas in protocol.ts, so a JSON frame is checked as
// strictly as the binary decoder checks bytes.

import { PROTOCOL_VERSION, parseGameMessage, type GameMessage } from "../protocol.ts";
import type { JsonCodec } from "./codec.ts";
import { CodecError } from "./errors.ts";

export const jsonCodec: JsonCodec = {
  name: "json",
  binary: false,

  encode(message: GameMessage): string {
    return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
  },

  decode(text: string): GameMessage {
    const result = parseGameMessage(text);
    if (!result.ok) throw new CodecError(result.reason);
    return result.msg;
  },
};
