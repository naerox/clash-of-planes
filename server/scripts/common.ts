// Small helpers the lab scripts share: command-line flags, starting a server child process, and
// narrowing the `unknown` that `catch` and JSON hand us.

import { spawn, type ChildProcess } from "node:child_process";

/** `--name=value` and bare `--flag` arguments as a record (a bare flag is "1"). */
export function parseArgs(argv: readonly string[] = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key) out[key] = value ?? "1";
  }
  return out;
}

/** The Node `code` of a thrown system error (`ENOENT`, …), or undefined. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/** Starts `src/index.ts` as a child process; resolves with it and the URL it logged. */
export async function startServer(
  entry: string,
  env: Record<string, string | undefined>,
): Promise<{ child: ChildProcess; base: string }> {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const base = await new Promise<string>((resolve) => {
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk;
      const m = buf.match(/"url":"(http:\/\/[^"]+)"/);
      if (m?.[1]) resolve(m[1]);
    });
  });
  return { child, base };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
