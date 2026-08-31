import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shareSocketWithGroup } from "./socket-group.js";

async function socket(t: { after(fn: () => void): void }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "sockgroup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "upstream.sock");
  const server: Server = createServer();
  server.listen(path);
  await once(server, "listening");
  t.after(() => server.close());
  return path;
}

test("without a group the socket is the owner's alone", async (t) => {
  const path = await socket(t);
  shareSocketWithGroup(path, undefined);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("with a group the socket widens one step and no further", async (t) => {
  const path = await socket(t);
  const gid = process.getgid?.();
  if (gid === undefined) {
    t.skip("no gid on this platform");
    return;
  }
  shareSocketWithGroup(path, String(gid));
  const stat = statSync(path);
  assert.equal(stat.mode & 0o777, 0o660);
  assert.equal(stat.gid, gid);
});

test("an unknown group stops the runtime rather than leaving a socket nobody can reach", async (t) => {
  const path = await socket(t);
  assert.throws(
    () => shareSocketWithGroup(path, "no-such-group-here"),
    /no-such-group-here.*no such group/,
  );
});
