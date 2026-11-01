import type { CodecName } from "../protocol.ts";
import { binaryCodec } from "./binary.ts";
import type { AnyCodec, BinaryCodec, JsonCodec } from "./codec.ts";
import { jsonCodec } from "./json.ts";

export { binaryCodec, jsonCodec };
export type { AnyCodec, BinaryCodec, Codec, JsonCodec } from "./codec.ts";
export { CodecError } from "./errors.ts";
export { SIZES as BINARY_SIZES } from "./binary.ts";

export function getCodec(name: "binary"): BinaryCodec;
export function getCodec(name: "json"): JsonCodec;
export function getCodec(name: CodecName): AnyCodec;
export function getCodec(name: CodecName): AnyCodec {
  switch (name) {
    case "binary":
      return binaryCodec;
    case "json":
      return jsonCodec;
    default: {
      // unreachable for typed callers; a value that slipped in from untyped code still fails loudly
      const unreachable: never = name;
      throw new RangeError(`unknown codec "${String(unreachable)}"`);
    }
  }
}
