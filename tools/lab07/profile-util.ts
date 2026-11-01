// Reading profiles: self time per function from a `.cpuprofile`, and bytes per function from the
// sampling heap profiler. Shared by the client recorder and the server profiler.

import { z } from "zod";

const profileSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
    }),
  ),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});

export function label(frame: { functionName: string; url: string; lineNumber: number }): string {
  const file = frame.url.split("/").slice(-1)[0] ?? "";
  return `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`;
}

/** Self time per function, in ms, from a `.cpuprofile`. */
export function selfTime(raw: unknown): { fn: string; ms: number; pct: number }[] {
  const p = profileSchema.parse(raw);
  const byId = new Map(p.nodes.map((n) => [n.id, n.callFrame]));
  const total = new Map<string, number>();
  p.samples.forEach((id, i) => {
    const frame = byId.get(id);
    if (!frame) return;
    const key = label(frame);
    total.set(key, (total.get(key) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
  });
  const sum = [...total.values()].reduce((s, x) => s + x, 0);
  return [...total]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms), pct: Math.round((1000 * ms) / sum) / 10 }));
}

interface HeapNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: HeapNode[];
}
const heapNodeSchema: z.ZodType<HeapNode> = z.lazy(() =>
  z.object({
    callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
    selfSize: z.number(),
    children: z.array(heapNodeSchema),
  }),
);

/** Bytes allocated per function (sampling heap profiler, minor and major GC survivors included). */
export function topAllocators(head: unknown): { fn: string; kb: number; pct: number }[] {
  const root = heapNodeSchema.parse(head);
  const total = new Map<string, number>();
  const walk = (n: HeapNode): void => {
    const key = label(n.callFrame);
    total.set(key, (total.get(key) ?? 0) + n.selfSize);
    n.children.forEach(walk);
  };
  walk(root);
  const sum = [...total.values()].reduce((s, x) => s + x, 0);
  return [...total]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([fn, bytes]) => ({
      fn,
      kb: Math.round(bytes / 1024),
      pct: Math.round((1000 * bytes) / sum) / 10,
    }));
}
