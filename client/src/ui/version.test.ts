import { test } from "vitest";
import assert from "node:assert/strict";
import { describeBuild, mountVersion, parseHealth } from "./version.ts";

const build = { version: "v1.0.0", sha: "abcdef1234567" };

test("describeBuild: the client's own build, and whether the server runs the same one", () => {
  assert.equal(describeBuild(build, null), "v1.0.0 · abcdef1");
  assert.match(describeBuild(build, { ...build }), /сервер той самий/);
  assert.match(describeBuild(build, { version: "v1.0.1", sha: "0000000aaaa" }), /інша збірка/);
});

test("parseHealth takes version and sha out of /health, and is null for anything else", () => {
  assert.deepEqual(parseHealth({ status: "ok", version: "v1", sha: "x", uptime: 1 }), {
    version: "v1",
    sha: "x",
  });
  assert.equal(parseHealth({ status: "ok" }), null);
  assert.equal(parseHealth(null), null);
  assert.equal(parseHealth("html"), null);
});

test("mountVersion shows the client build first and survives a server that does not answer", async () => {
  const el = { textContent: "" };
  await mountVersion(el, () => Promise.reject(new Error("offline")));
  assert.match(el.textContent ?? "", /^dev · unknown$/);
});
