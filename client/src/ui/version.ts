// "What is running?" in one corner of the page: the client's own build, and the server's (asked
// from /health). When the two differ — a tab left open across a deploy — it says so.

import { z } from "zod";

export interface BuildInfo {
  readonly version: string;
  readonly sha: string;
}

export const CLIENT_BUILD: BuildInfo = {
  version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
  sha: typeof __GIT_SHA__ === "string" ? __GIT_SHA__ : "unknown",
};

const short = (sha: string): string => sha.slice(0, 7);

/** The sentence under the lobby: `v1.0.0 · abc1234`, plus the server's if it is a different build. */
export function describeBuild(client: BuildInfo, server: BuildInfo | null): string {
  const mine = `${client.version} · ${short(client.sha)}`;
  if (!server) return mine;
  if (server.sha === client.sha && server.version === client.version)
    return `${mine} · сервер той самий`;
  return `${mine} · сервер ${server.version} · ${short(server.sha)} (інша збірка: оновіть сторінку)`;
}

/** Reads `{ version, sha }` out of a /health body (anything else is "unknown": never throws). */
const healthSchema = z.object({ version: z.string(), sha: z.string() });

export function parseHealth(body: unknown): BuildInfo | null {
  const parsed = healthSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export async function mountVersion(
  el: Pick<HTMLElement, "textContent">,
  fetchHealth: () => Promise<unknown> = () => fetch("/health").then((r) => r.json()),
): Promise<void> {
  el.textContent = describeBuild(CLIENT_BUILD, null);
  try {
    el.textContent = describeBuild(CLIENT_BUILD, parseHealth(await fetchHealth()));
  } catch {
    /* the server is not answering: the client's own build is still worth showing */
  }
}
