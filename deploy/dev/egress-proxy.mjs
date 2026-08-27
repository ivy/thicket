// Stand-in for netd's outbound side, for local development only.
//
// netd listens on a unix socket and forwards HTTP out through the tailnet,
// which is what bounds where an agent can reach: tailnet peers, nothing
// else. This dials plain TCP instead, so it has no such bound — which is
// precisely why it must never run anywhere real.
//
//   SOCKET=$XDG_RUNTIME_DIR/thicket/netd-egress.sock node egress-proxy.mjs
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";
import { connect } from "node:net";

const SOCKET = process.env.SOCKET;
if (SOCKET === undefined) {
  console.error("SOCKET is required");
  process.exit(2);
}
try {
  unlinkSync(SOCKET);
} catch {
  // not there yet
}

// Only CONNECT is handled: that is all egressFetch issues, https and plain
// http alike, so TLS terminates at the peer rather than here.
createServer((client) => {
  client.once("data", (chunk) => {
    const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
    const [method, target] = line.split(" ");
    if (method !== "CONNECT") {
      client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      return;
    }
    const [host, port] = target.split(":");
    const upstream = connect({ host, port: Number(port) }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", (err) => {
      client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err}`);
    });
  });
  client.on("error", () => {});
}).listen(SOCKET, () => {
  console.log(`egress proxy: ${SOCKET} -> tcp (DEV ONLY, not tailnet-bounded)`);
});
