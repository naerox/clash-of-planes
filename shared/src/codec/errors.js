/** Thrown by a codec for anything it cannot decode: truncated, wrong version, bad values. */
export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}
