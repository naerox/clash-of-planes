import type { CodecName, GameMessage } from "../protocol.ts";
import type { SnapshotRecycler } from "./recycler.ts";

/**
 * What a codec is: a pair of functions between a logical `GameMessage` and a wire frame.
 * `Wire` is what `encode` produces (a string or bytes); `Incoming` is what `decode` accepts —
 * wider for bytes, because a browser hands over an ArrayBuffer and `ws` a Buffer.
 *
 * `decode` never trusts its input: it either returns a fully valid message or throws a
 * `CodecError`, so nothing downstream has to re-check anything.
 */
export interface Codec<Wire extends string | Uint8Array, Incoming = Wire> {
  readonly name: CodecName;
  readonly binary: boolean;
  encode(message: GameMessage): Wire;
  /** @throws {CodecError} on anything malformed */
  decode(data: Incoming): GameMessage;
}

export interface JsonCodec extends Codec<string> {
  readonly name: "json";
  readonly binary: false;
}

export interface BinaryCodec extends Codec<Uint8Array, ArrayBuffer | Uint8Array> {
  readonly name: "binary";
  readonly binary: true;
  /** With a `recycler`, a snapshot is built from recycled records instead of fresh objects. */
  decode(data: ArrayBuffer | Uint8Array, recycler?: SnapshotRecycler): GameMessage;
}

/** Either implementation; `codec.binary` tells which. */
export type AnyCodec = JsonCodec | BinaryCodec;
