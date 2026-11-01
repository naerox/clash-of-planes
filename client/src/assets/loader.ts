// One loader per asset type. All three share the same shape — `(url, { signal, onBytes,
// onRetry, ... }) → Promise<value>` — so loadAll can treat them uniformly.

import { abortable } from "../async.ts";
import { fetchBytes, fetchJson, withRetry, type FetchOptions } from "../net/http.ts";

// The lab's `withRetry` and shared `fetchJson` live in net/http.js (lobby uses them too);
// re-exported here so everything the asset pipeline needs is importable from one place.
export { fetchJson, withRetry };

/** Callback API → Promise: <img> only knows onload/onerror, so we wrap it once here. */
function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Не вдалося декодувати зображення (${blob.size} B)`));
    };
    img.src = url;
  });
}

/** What every loader accepts: the fetch options (signal, retries, byte progress). */
export type LoadOptions = FetchOptions;

export type AssetType = "image" | "audio" | "json";

/** The shape all loaders share, so loadAll can treat them uniformly. */
export type Loader = (url: string, opts?: LoadOptions) => Promise<unknown>;
export type Loaders = Readonly<Record<AssetType, Loader>>;

export async function loadImage(
  url: string,
  { signal, ...opts }: LoadOptions = {},
): Promise<HTMLImageElement> {
  const bytes = await fetchBytes(url, { signal, ...opts });
  return abortable(decodeImage(new Blob([bytes])), signal);
}

// AudioBuffers are not tied to the context that decoded them, so we decode during loading
// with an OfflineAudioContext (allowed before any user gesture) and play them later in the
// real AudioContext, which audio.js creates only after the player clicks or presses a key.
let decoder: OfflineAudioContext | null = null;
function audioDecoder(): OfflineAudioContext {
  decoder ??= new OfflineAudioContext(1, 1, 44100);
  return decoder;
}

/** `ctx` may be any BaseAudioContext; by default the offline decoder above is used. */
export async function loadAudio(
  url: string,
  { signal, ctx, ...opts }: LoadOptions & { ctx?: BaseAudioContext } = {},
): Promise<AudioBuffer> {
  const bytes = await fetchBytes(url, { signal, ...opts });
  // decodeAudioData detaches the buffer it is given — pass it an exact-size copy.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return abortable((ctx ?? audioDecoder()).decodeAudioData(buffer), signal);
}

export function loadJson(url: string, opts?: LoadOptions): Promise<unknown> {
  return fetchJson(url, opts);
}

export const LOADERS: Loaders = Object.freeze({
  image: loadImage,
  audio: loadAudio,
  json: loadJson,
});
