// The asset pipeline: manifest → per-file loaders → one Map of results, with per-file
// progress for the loading screen.

import { LOADERS } from "./loaders.js";
import { fetchJson } from "../net/http.js";
import { isAbortError } from "../async.js";

export function loadManifest(url, opts) {
  return fetchJson(url, opts).then((m) => {
    if (!Array.isArray(m?.assets)) throw new TypeError(`${url}: немає масиву "assets"`);
    return m;
  });
}

/**
 * Per-file state the loading screen draws from. `status` goes
 * pending → loading (→ retrying → loading)* → done | failed | cancelled.
 * A failed file counts as finished (its fate is decided); a cancelled one does not.
 */
function createTracker(entries, onProgress) {
  const files = entries.map((e) => ({
    id: e.id,
    url: e.url,
    optional: Boolean(e.optional),
    status: "pending",
    loaded: 0,
    total: e.size ?? 0,
    attempt: 1,
    error: null,
  }));
  const byId = new Map(files.map((f) => [f.id, f]));

  const snapshot = () => {
    let weightDone = 0;
    let weightAll = 0;
    for (const f of files) {
      const w = f.total || 1;
      weightAll += w;
      if (f.status === "done" || f.status === "failed") weightDone += w;
      else if (f.total) weightDone += Math.min(f.loaded, f.total);
    }
    return {
      files,
      fraction: weightAll ? weightDone / weightAll : 1,
      finished: files.filter((f) => f.status === "done" || f.status === "failed").length,
    };
  };
  const emit = () => onProgress?.(snapshot());

  return {
    update(id, patch) {
      Object.assign(byId.get(id), patch);
      emit();
    },
    snapshot,
  };
}

function resolveUrl(url, baseUrl) {
  return baseUrl ? new URL(url, baseUrl).href : url;
}

async function loadEntry(entry, tracker, { signal, loaders, baseUrl, net }) {
  const load = loaders[entry.type];
  if (!load) throw new TypeError(`Невідомий тип ассета "${entry.type}" (${entry.id})`);
  tracker.update(entry.id, { status: "loading" });
  const value = await load(resolveUrl(entry.url, baseUrl), {
    ...net,
    signal,
    onBytes: (loaded, total) =>
      tracker.update(entry.id, { loaded, total: total || entry.size || 0 }),
    onRetry: ({ attempt, delayMs, error }) =>
      tracker.update(entry.id, {
        status: "retrying",
        attempt: attempt + 1,
        loaded: 0,
        error: `${error.message} → повтор через ${delayMs} мс`,
      }),
  });
  tracker.update(entry.id, { status: "done", error: null });
  return value;
}

/** What loadAll does when one file fails: optional → `null` + a note, required → rethrow. */
function settle(entry, err, tracker, callerSignal) {
  const aborted = callerSignal?.aborted || isAbortError(err);
  tracker.update(entry.id, {
    status: aborted ? "cancelled" : "failed",
    error: err.message ?? String(err),
  });
  if (aborted) throw err; // a real abort is never "optional"
  if (entry.optional) return null;
  throw err;
}

/**
 * Loads every manifest entry *concurrently*: all fetches start in the same tick and
 * `Promise.all` waits for the slowest one. Optional assets (sprites, sounds) that fail
 * resolve to `null` so the game can fall back to vector shapes / silence; a required one
 * rejects the whole `Promise.all` — and, because Promise.all does not cancel anything by
 * itself, we abort the still-running siblings through a linked AbortController.
 *
 * Resolves to `{ assets: Map<id, value|null>, failures: [{id, url, error}] }`.
 */
export async function loadAll(
  manifest,
  { signal, onProgress, loaders = LOADERS, baseUrl, ...net } = {},
) {
  const tracker = createTracker(manifest.assets, onProgress);
  const failFast = new AbortController();
  const linked = signal ? AbortSignal.any([signal, failFast.signal]) : failFast.signal;
  const ctx = { signal: linked, loaders, baseUrl, net };

  const tasks = manifest.assets.map(async (entry) => {
    try {
      return [entry.id, await loadEntry(entry, tracker, ctx)];
    } catch (err) {
      try {
        return [entry.id, settle(entry, err, tracker, signal)];
      } catch (fatal) {
        if (!failFast.signal.aborted) {
          failFast.abort(
            new DOMException(`Скасовано: "${entry.id}" не завантажився`, "AbortError"),
          );
        }
        throw fatal;
      }
    }
  });

  const pairs = await Promise.all(tasks);
  return collect(pairs, tracker);
}

/** The same work one file at a time — only for the sequential-vs-concurrent benchmark. */
export async function loadSequential(
  manifest,
  { signal, onProgress, loaders = LOADERS, baseUrl, ...net } = {},
) {
  const tracker = createTracker(manifest.assets, onProgress);
  const ctx = { signal, loaders, baseUrl, net };
  const pairs = [];
  for (const entry of manifest.assets) {
    try {
      pairs.push([entry.id, await loadEntry(entry, tracker, ctx)]);
    } catch (err) {
      pairs.push([entry.id, settle(entry, err, tracker, signal)]);
    }
  }
  return collect(pairs, tracker);
}

function collect(pairs, tracker) {
  const failures = tracker
    .snapshot()
    .files.filter((f) => f.status === "failed")
    .map(({ id, url, error }) => ({ id, url, error }));
  return { assets: new Map(pairs), failures };
}
