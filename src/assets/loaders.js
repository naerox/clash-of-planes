// One loader per asset type. All three share the same shape — `(url, { signal, onBytes,
// onRetry, ... }) → Promise<value>` — so loadAll can treat them uniformly.

import { abortable } from "../async.js";
import { fetchBytes, fetchJson } from "../net/http.js";

/** Callback API → Promise: <img> only knows onload/onerror, so we wrap it once here. */
function decodeImage(blob) {
  return new Promise((resolve, reject) => {
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

export async function loadImage(url, { signal, ...opts } = {}) {
  const bytes = await fetchBytes(url, { signal, ...opts });
  return abortable(decodeImage(new Blob([bytes])), signal);
}

// AudioBuffers are not tied to the context that decoded them, so we decode during loading
// with an OfflineAudioContext (allowed before any user gesture) and play them later in the
// real AudioContext, which audio.js creates only after the player clicks or presses a key.
let decoder = null;
function audioDecoder() {
  decoder ??= new OfflineAudioContext(1, 1, 44100);
  return decoder;
}

export async function loadAudio(url, { signal, ...opts } = {}) {
  const bytes = await fetchBytes(url, { signal, ...opts });
  // decodeAudioData detaches the buffer it is given — pass it an exact-size copy.
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return abortable(audioDecoder().decodeAudioData(buffer), signal);
}

export function loadJson(url, opts) {
  return fetchJson(url, opts);
}

export const LOADERS = Object.freeze({ image: loadImage, audio: loadAudio, json: loadJson });
