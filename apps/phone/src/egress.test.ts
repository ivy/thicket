import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:net";

import { egressFetch } from "@thicket/egress";

import { SlackAlertPoster } from "./alerts.js";

/**
 * A proxy that records what it was asked for and refuses it. Refusing makes
 * the assertion sharp: the call has to fail *here*, at the socket, rather
 * than succeed some other way.
 */
async function recordingProxy(t: { after(fn: () => void): void }): Promise<{
  socketPath: string;
  connects: string[];
}> {
  const socketPath = `/tmp/thicket-phone-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
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

// The phone bridge is the one component the public internet reaches, so what
// it can reach back matters: its alerts go out the same socket as everything
// else, and nowhere else.
test("a security alert leaves through the egress socket, or not at all", async (t) => {
  const proxy = await recordingProxy(t);
  const posted: string[] = [];
  const poster = new SlackAlertPoster({
    channel: "C0000000000",
    botToken: "xoxb-not-a-real-token",
    showNumbers: false,
    logger: { info: () => {}, warn: (msg) => posted.push(msg) },
    fetchImpl: egressFetch(proxy.socketPath),
  });

  await poster.post({
    kind: "auth_failed",
    callSid: "CA00000000000000000000000000000000",
    from: "+15550100002",
    attempt: 1,
    final: false,
  });

  assert.deepEqual(
    proxy.connects,
    ["slack.com:443"],
    "the alert must reach Slack by asking netd for it, never by dialing",
  );
});
