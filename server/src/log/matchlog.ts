// Match logs: every room event becomes one NDJSON line in LOG_DIR/<room>-<timestamp>.ndjson.
//
//   room "event"s ──► async generator ──► Readable.from ──► NdjsonEncoder ──► file
//                      (events.on)         (object mode)    (Transform)      (write stream)
//
// `pipeline` wires the four together, applies backpressure along the whole chain (a slow
// disk slows the generator, which just lets events queue inside `events.on`) and destroys
// every stage if any of them fails.

import { createWriteStream, mkdirSync } from "node:fs";
import { on, type EventEmitter } from "node:events";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Object-mode in, bytes out: `{ t, type, … }` → `{"t":…}\n`. */
export class NdjsonEncoder extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  override _transform(
    event: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (err: unknown) {
      // e.g. a BigInt or a circular reference: fail the stream, loudly
      callback(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    callback(null, line);
  }
}

async function* eventsOf(iterator: AsyncIterable<unknown[]>): AsyncGenerator<unknown> {
  try {
    for await (const [event] of iterator) yield event;
  } catch (err: unknown) {
    // `events.on` rejects with AbortError after the signal fires — but only once it has
    // handed over every event it had already queued, so nothing is lost. For us that is
    // simply "the source ended": return normally, so pipeline flushes and closes the file.
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
  }
}

/** Starts logging `room`'s "event"s. `stop()` ends the log after the events emitted so far. */
export interface MatchLogOptions {
  dir: string;
  now?: () => number;
  onError?: (err: Error, file: string) => void;
}

export interface MatchLog {
  readonly file: string;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

/** What a log needs from a room: an id for the file name, and the "event" stream to record. */
export interface LogSource extends EventEmitter {
  readonly id: string;
}

export function createMatchLog(
  room: LogSource,
  { dir, now = Date.now, onError = () => {} }: MatchLogOptions,
): MatchLog {
  const file = join(dir, `${room.id}-${now()}.ndjson`);
  const ac = new AbortController();
  // Subscribe NOW, synchronously: a lazily started generator would miss events emitted
  // between this call and the first read.
  const iterator = on(room, "event", { signal: ac.signal });

  const done = pipeline(
    Readable.from(eventsOf(iterator), { objectMode: true }),
    new NdjsonEncoder(),
    createWriteStream(file),
  ).catch((err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)), file);
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
  #active = new Map<string, MatchLog>(); // room.id → log
  #closing = new Set<Promise<void>>(); // stop() promises still in flight
  readonly dir: string;
  readonly now: (() => number) | undefined;
  readonly onError: ((err: Error, file: string) => void) | undefined;

  constructor({ dir, now, onError }: MatchLogOptions) {
    this.dir = dir;
    this.now = now;
    this.onError = onError;
    mkdirSync(dir, { recursive: true });
  }

  attach(room: LogSource): MatchLog {
    const log = createMatchLog(room, { dir: this.dir, now: this.now, onError: this.onError });
    this.#active.set(room.id, log);
    return log;
  }

  detach(room: LogSource): Promise<void> {
    const log = this.#active.get(room.id);
    if (!log) return Promise.resolve();
    this.#active.delete(room.id);
    const closing = log.stop().finally(() => this.#closing.delete(closing));
    this.#closing.add(closing);
    return closing;
  }

  fileOf(room: LogSource): string | undefined {
    return this.#active.get(room.id)?.file;
  }

  /** Graceful shutdown: every log is flushed and its file closed before this resolves. */
  async closeAll(): Promise<void> {
    for (const log of this.#active.values()) {
      const closing = log.stop().finally(() => this.#closing.delete(closing));
      this.#closing.add(closing);
    }
    this.#active.clear();
    await Promise.all(this.#closing);
  }
}
