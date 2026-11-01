// Match logs: every room event becomes one NDJSON line in LOG_DIR/<room>-<timestamp>.ndjson.
//
//   room "event"s ──► async generator ──► Readable.from ──► NdjsonEncoder ──► file
//                      (events.on)         (object mode)    (Transform)      (write stream)
//
// `pipeline` wires the four together, applies backpressure along the whole chain (a slow
// disk slows the generator, which just lets events queue inside `events.on`) and destroys
// every stage if any of them fails.

import { createWriteStream, mkdirSync } from "node:fs";
import { on } from "node:events";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Object-mode in, bytes out: `{ t, type, … }` → `{"t":…}\n`. */
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(event, _encoding, callback) {
    let line;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (err) {
      callback(err); // e.g. a BigInt or a circular reference: fail the stream, loudly
      return;
    }
    callback(null, line);
  }
}

async function* eventsOf(iterator) {
  try {
    for await (const [event] of iterator) yield event;
  } catch (err) {
    // `events.on` rejects with AbortError after the signal fires — but only once it has
    // handed over every event it had already queued, so nothing is lost. For us that is
    // simply "the source ended": return normally, so pipeline flushes and closes the file.
    if (err.name !== "AbortError") throw err;
  }
}

/** Starts logging `room`'s "event"s. `stop()` ends the log after the events emitted so far. */
export function createMatchLog(room, { dir, now = Date.now, onError = () => {} }) {
  const file = join(dir, `${room.id}-${now()}.ndjson`);
  const ac = new AbortController();
  // Subscribe NOW, synchronously: a lazily started generator would miss events emitted
  // between this call and the first read.
  const iterator = on(room, "event", { signal: ac.signal });

  const done = pipeline(
    Readable.from(eventsOf(iterator), { objectMode: true }),
    new NdjsonEncoder(),
    createWriteStream(file),
  ).catch((err) => {
    onError(err, file);
  });

  return {
    file,
    done,
    async stop() {
      ac.abort();
      await done;
    },
  };
}

/** The set of logs for all live rooms; the app wires it to the RoomManager's events. */
export class MatchLogs {
  #active = new Map(); // room.id → log
  #closing = new Set(); // stop() promises still in flight

  constructor({ dir, now, onError }) {
    this.dir = dir;
    this.now = now;
    this.onError = onError;
    mkdirSync(dir, { recursive: true });
  }

  attach(room) {
    const log = createMatchLog(room, { dir: this.dir, now: this.now, onError: this.onError });
    this.#active.set(room.id, log);
    return log;
  }

  detach(room) {
    const log = this.#active.get(room.id);
    if (!log) return Promise.resolve();
    this.#active.delete(room.id);
    const closing = log.stop().finally(() => this.#closing.delete(closing));
    this.#closing.add(closing);
    return closing;
  }

  fileOf(room) {
    return this.#active.get(room.id)?.file;
  }

  /** Graceful shutdown: every log is flushed and its file closed before this resolves. */
  async closeAll() {
    for (const log of this.#active.values()) {
      const closing = log.stop().finally(() => this.#closing.delete(closing));
      this.#closing.add(closing);
    }
    this.#active.clear();
    await Promise.all(this.#closing);
  }
}
