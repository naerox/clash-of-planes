// The only globals shared/src may use besides the language itself: the UTF-8 codec classes that
// the browser AND Node both provide. Declared here, minimally, because this folder is compiled
// with neither the DOM library nor @types/node.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
