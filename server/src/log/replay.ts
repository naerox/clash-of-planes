// Reading a match log back — also as a stream, never `readFile` of the whole thing.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** `<room-id>-<ms timestamp>`: the only shape a replay id may have (no dots, no slashes). */
const REPLAY_ID = /^[a-z0-9-]{1,80}-\d{10,16}$/;

export function replayPath(dir: string, id: string): string | null {
  return REPLAY_ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

/**
 * Async generator over a log file: createReadStream + a line splitter, yielding one parsed
 * event at a time. Memory use is one line, whatever the file size. A line that is not JSON
 * (say, the tail of a log cut short by a crash) throws with its line number, unless
 * `onBadLine` is given — then it is reported and skipped.
 */
export interface BadLine {
  readonly line: number;
  readonly text: string;
  readonly error: unknown;
}

/** One parsed line of a log. Its shape is whatever the writer wrote, so callers must check it. */
export async function* replayEvents(
  file: string,
  { onBadLine }: { onBadLine?: (bad: BadLine) => void } = {},
): AsyncGenerator<unknown> {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      n++;
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (err: unknown) {
        if (!onBadLine) {
          const why = err instanceof Error ? err.message : String(err);
          throw new SyntaxError(`${file}:${n}: ${why}`, { cause: err });
        }
        onBadLine({ line: n, text: line, error: err });
        continue;
      }
      yield event;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export interface ReplayInfo {
  readonly id: string;
  readonly size: number;
  readonly modified: number;
}

export async function listReplays(dir: string): Promise<ReplayInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  const out: ReplayInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".ndjson")) continue;
    const id = name.slice(0, -".ndjson".length);
    if (!REPLAY_ID.test(id)) continue;
    const { size, mtimeMs } = await stat(join(dir, name));
    out.push({ id, size, modified: Math.round(mtimeMs) });
  }
  return out.sort((a, b) => b.modified - a.modified);
}
