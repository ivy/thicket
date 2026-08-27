import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { egressFetch } from "./egress.js";

interface Proxy {
  socketPath: string;
  connects: string[];
  refuse: boolean;
  close(): Promise<void>;
}

/**
 * The CONNECT half of netd's egress proxy: enough of the contract to prove
 * the adapter speaks it, without a tailnet.
 */
async function proxy(t: { after(fn: () => void): void }): Promise<Proxy> {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "egress.sock");
  const state: Proxy = {
    socketPath,
    connects: [],
    refuse: false,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
  const server: SocketServer = createSocketServer((client) => {
    client.once("data", (chunk) => {
      const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
      const [method, target] = line.split(" ");
      if (method !== "CONNECT" || target === undefined) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      state.connects.push(target);
      if (state.refuse) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const [host, port] = target.split(":");
      const upstream = connect({ host, port: Number(port) }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    });
    client.on("error", () => {});
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => void state.close());
  return state;
}

async function origin(
  t: { after(fn: () => void): void },
  handler: Parameters<typeof createHttpServer>[1],
): Promise<{ url: string; port: number }> {
  const server: Server = createHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

test("a request tunnels through the proxy and comes back whole", async (t) => {
  const p = await proxy(t);
  const seen: { url?: string; host?: string } = {};
  const o = await origin(t, (req, res) => {
    seen.url = req.url;
    seen.host = req.headers.host;
    res.writeHead(200, { "content-type": "text/csv" });
    res.end("hello world");
  });

  const res = await egressFetch(p.socketPath)(`${o.url}/files/F1?x=1`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello world");
  assert.equal(res.headers.get("content-type"), "text/csv");
  assert.equal(seen.url, "/files/F1?x=1", "path and query survive the tunnel");
  assert.equal(seen.host, `127.0.0.1:${o.port}`);
  assert.deepEqual(p.connects, [`127.0.0.1:${o.port}`], "one CONNECT to the real target");
});

test("request headers reach the origin", async (t) => {
  const p = await proxy(t);
  let auth: string | undefined;
  const o = await origin(t, (req, res) => {
    auth = req.headers.authorization;
    res.end("ok");
  });

  await egressFetch(p.socketPath)(`${o.url}/x`, { headers: { authorization: "Bearer t" } });
  assert.equal(auth, "Bearer t");
});

test("a proxy refusal surfaces as an error, not as an empty body", async (t) => {
  const p = await proxy(t);
  p.refuse = true;
  const o = await origin(t, (_req, res) => res.end("unreachable"));

  await assert.rejects(() => egressFetch(p.socketPath)(`${o.url}/x`), /refused CONNECT: .*403/);
});

test("an absent egress socket fails loudly rather than dialing directly", async (t) => {
  const o = await origin(t, (_req, res) => res.end("must not be reached"));
  await assert.rejects(
    () => egressFetch(join(tmpdir(), "thicket-no-such-egress.sock"))(`${o.url}/x`),
    /ENOENT/,
  );
});

test("a large body streams through without being buffered whole", async (t) => {
  const p = await proxy(t);
  const chunk = Buffer.alloc(64 * 1024, 7);
  const o = await origin(t, (_req, res) => {
    res.writeHead(200);
    for (let i = 0; i < 16; i += 1) {
      res.write(chunk);
    }
    res.end();
  });

  const res = await egressFetch(p.socketPath)(`${o.url}/big`);
  let total = 0;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += part.length;
  }
  assert.equal(total, 16 * 64 * 1024);
});
