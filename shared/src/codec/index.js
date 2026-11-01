import { binaryCodec } from "./binary.js";
import { jsonCodec } from "./json.js";

export { binaryCodec, jsonCodec };
export { CodecError } from "./errors.js";
export { SIZES as BINARY_SIZES } from "./binary.js";

const CODECS = { binary: binaryCodec, json: jsonCodec };

/** @param {"binary"|"json"} name */
export function getCodec(name) {
  const codec = CODECS[name];
  if (!codec) throw new RangeError(`unknown codec "${name}"`);
  return codec;
}
