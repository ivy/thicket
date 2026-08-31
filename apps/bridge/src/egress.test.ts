import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebClient } from "@slack/web-api";
import { egressAgent } from "@thicket/egress";

/**
 * A proxy that records what it was asked for and refuses it. Refusing is
 * what makes the assertion sharp: the call has to fail *here*, at the
 * socket, rather than succeed some other way.
 */
async function recordingProxy(t: { after(fn: () => void): void }): Promise<{
  socketPath: string;
  connects: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "bridge-egress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "netd-egress.sock");
  const connects: string[] = [];
  const server: Server = createServer((client) => {
    client.once("data", (chunk: Buffer) => {
      const [line] = chunk.toString("latin1").split("\r\n");
      const [method, target] = (line ?? "").split(" ");
      if (method === "CONNECT" && target !== undefined) {
        connects.push(target);
      }
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    client.on("error", () => {});
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => server.close());
  return { socketPath, connects };
}

test("the Slack Web API leaves through the egress socket, or not at all", async (t) => {
  const proxy = await recordingProxy(t);
  const web = new WebClient("xoxb-not-a-real-token", {
    agent: egressAgent(proxy.socketPath),
    retryConfig: { retries: 0 },
  });

  await assert.rejects(() => web.auth.test());
  assert.deepEqual(
    proxy.connects,
    ["slack.com:443"],
    "the call must reach Slack by asking netd for it, never by dialing",
  );
});
