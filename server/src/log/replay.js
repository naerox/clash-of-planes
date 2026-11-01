// Reading a match log back — also as a stream, never `readFile` of the whole thing.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** `<room-id>-<ms timestamp>`: the only shape a replay id may have (no dots, no slashes). */
const REPLAY_ID = /^[a-z0-9-]{1,80}-\d{10,16}$/;

export function replayPath(dir, id) {
  return REPLAY_ID.test(id) ? join(dir, `${id}.ndjson`) : null;
}

/**
 * Async generator over a log file: createReadStream + a line splitter, yielding one parsed
 * event at a time. Memory use is one line, whatever the file size. A line that is not JSON
 * (say, the tail of a log cut short by a crash) throws with its line number, unless
 * `onBadLine` is given — then it is reported and skipped.
 */
export async function* replayEvents(file, { onBadLine } = {}) {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      n++;
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        if (!onBadLine) throw new SyntaxError(`${file}:${n}: ${err.message}`, { cause: err });
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

export async function listReplays(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".ndjson")) continue;
    const id = name.slice(0, -".ndjson".length);
    if (!REPLAY_ID.test(id)) continue;
    const { size, mtimeMs } = await stat(join(dir, name));
    out.push({ id, size, modified: Math.round(mtimeMs) });
  }
  return out.sort((a, b) => b.modified - a.modified);
}
