import { z } from "zod";
import { LOADERS, type Loaders } from "./loader.ts";
import { fetchJson, type FetchOptions } from "../net/http.ts";
import { errorMessage } from "../errors.ts";
import { isAbortError } from "../async.ts";

/** `public/assets/manifest.json`: a JSON file we fetch is `unknown` until this has checked it. */
export const manifestSchema = z.object({
  version: z.number().optional(),
  assets: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["image", "audio", "json"]),
      url: z.string(),
      size: z.number().optional(),
      optional: z.boolean().optional(),
    }),
  ),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type AssetEntry = Manifest["assets"][number];

export async function loadManifest(url: string, opts?: FetchOptions): Promise<Manifest> {
  const parsed = manifestSchema.safeParse(await fetchJson(url, opts));
  if (!parsed.success) {
    throw new TypeError(`${url}: ${parsed.error.issues[0]?.message ?? "невірний маніфест"}`);
  }
  return parsed.data;
}

export type FileStatus = "pending" | "loading" | "retrying" | "done" | "failed" | "cancelled";

/** One file's state, as the loading screen draws it. */
export interface FileProgress {
  readonly id: string;
  readonly url: string;
  readonly optional: boolean;
  status: FileStatus;
  loaded: number;
  total: number;
  attempt: number;
  error: string | null;
}

export interface Progress {
  readonly files: readonly FileProgress[];
  readonly fraction: number;
  readonly finished: number;
}

export interface LoadFailure {
  readonly id: string;
  readonly url: string;
  readonly error: string | null;
}

export interface LoadResult {
  readonly assets: Map<string, unknown>;
  readonly failures: LoadFailure[];
}

export interface LoadAllOptions extends FetchOptions {
  onProgress?: (progress: Progress) => void;
  loaders?: Loaders;
  baseUrl?: string | URL;
}

/**
 * Per-file state the loading screen draws from. `status` goes
 * pending → loading (→ retrying → loading)* → done | failed | cancelled.
 * A failed file counts as finished (its fate is decided); a cancelled one does not.
 */
function createTracker(entries: readonly AssetEntry[], onProgress?: (p: Progress) => void) {
  const files: FileProgress[] = entries.map((e) => ({
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

  const snapshot = (): Progress => {
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
  const emit = (): void => onProgress?.(snapshot());

  return {
    update(id: string, patch: Partial<FileProgress>): void {
      const file = byId.get(id);
      if (file) Object.assign(file, patch);
      emit();
    },
    snapshot,
  };
}

type Tracker = ReturnType<typeof createTracker>;

function resolveUrl(url: string, baseUrl?: string | URL): string {
  return baseUrl ? new URL(url, baseUrl).href : url;
}

interface EntryContext {
  signal: AbortSignal | undefined;
  loaders: Loaders;
  baseUrl: string | URL | undefined;
  net: FetchOptions;
}

async function loadEntry(
  entry: AssetEntry,
  tracker: Tracker,
  { signal, loaders, baseUrl, net }: EntryContext,
): Promise<unknown> {
  const load = loaders[entry.type];
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
        error: `${errorMessage(error)} → повтор через ${delayMs} мс`,
      }),
  });
  tracker.update(entry.id, { status: "done", error: null });
  return value;
}

/** What loadAll does when one file fails: optional → `null` + a note, required → rethrow. */
function settle(
  entry: AssetEntry,
  err: unknown,
  tracker: Tracker,
  callerSignal: AbortSignal | undefined,
): null {
  const aborted = callerSignal?.aborted || isAbortError(err);
  tracker.update(entry.id, {
    status: aborted ? "cancelled" : "failed",
    error: errorMessage(err),
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
  manifest: Manifest,
  { signal, onProgress, loaders = LOADERS, baseUrl, ...net }: LoadAllOptions = {},
): Promise<LoadResult> {
  const tracker = createTracker(manifest.assets, onProgress);
  const failFast = new AbortController();
  const linked = signal ? AbortSignal.any([signal, failFast.signal]) : failFast.signal;
  const ctx: EntryContext = { signal: linked, loaders, baseUrl, net };

  const tasks = manifest.assets.map(async (entry): Promise<[string, unknown]> => {
    try {
      return [entry.id, await loadEntry(entry, tracker, ctx)];
    } catch (err: unknown) {
      try {
        return [entry.id, settle(entry, err, tracker, signal)];
      } catch (fatal: unknown) {
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
  manifest: Manifest,
  { signal, onProgress, loaders = LOADERS, baseUrl, ...net }: LoadAllOptions = {},
): Promise<LoadResult> {
  const tracker = createTracker(manifest.assets, onProgress);
  const ctx: EntryContext = { signal, loaders, baseUrl, net };
  const pairs: [string, unknown][] = [];
  for (const entry of manifest.assets) {
    try {
      pairs.push([entry.id, await loadEntry(entry, tracker, ctx)]);
    } catch (err: unknown) {
      pairs.push([entry.id, settle(entry, err, tracker, signal)]);
    }
  }
  return collect(pairs, tracker);
}

function collect(pairs: [string, unknown][], tracker: Tracker): LoadResult {
  const failures = tracker
    .snapshot()
    .files.filter((f) => f.status === "failed")
    .map(({ id, url, error }) => ({ id, url, error }));
  return { assets: new Map(pairs), failures };
}
