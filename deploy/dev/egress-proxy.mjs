// Stand-in for netd's outbound side, for local development only.
//
// netd listens on a unix socket and forwards HTTP out through the tailnet,
// which is what bounds where an agent can reach: tailnet peers, nothing
// else. This dials plain TCP instead, so it has no such bound — which is
// precisely why it must never run anywhere real.
//
// The contract is netd's (netd/proxy.go, newEgressProxy): a forward proxy
// that takes absolute-form requests — `GET http://host:port/path` — and
// CONNECT tunnels. agentd tunnels everything; the CLI sends plain-http
// targets in absolute form; both must work here or a live check measures
// the stand-in instead of the code.
//
//   SOCKET=$XDG_RUNTIME_DIR/thicket/netd-egress.sock node egress-proxy.mjs
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

/** Headers that describe this hop, not the message; a proxy drops them. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

const server = createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url ?? "");
  } catch {
    target = undefined;
  }
  if (target === undefined || (target.protocol !== "http:" && target.protocol !== "https:")) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("egress proxy requires absolute-form request URIs or CONNECT\n");
    return;
  }
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = request(
    {
      host: target.hostname,
      port: target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port),
      method: req.method,
      path: target.pathname + target.search,
      headers: withoutHopByHop(req.headers),
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, withoutHopByHop(response.headers));
      // Flush as it comes: A2A streams server-sent events, and a
      // buffered proxy would hold every chunk until the turn ended.
      response.on("data", (chunk) => res.write(chunk));
      response.on("end", () => res.end());
    },
  );
  upstream.on("error", (err) => {
    console.error(`egress: ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("egress dial failed\n");
  });
  req.pipe(upstream);
});

// CONNECT: open the tunnel and step out of the way; TLS, if any, ends at
// the peer, not here.
server.on("connect", (req, client, head) => {
  const [host, port] = String(req.url).split(":");
  const upstream = connect({ host, port: Number(port) }, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", (err) => {
    console.error(`egress: CONNECT ${req.url}: ${err.message}`);
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  client.on("error", () => upstream.destroy());
});

server.listen(SOCKET, () => {
  console.log(`egress proxy: ${SOCKET} -> tcp (DEV ONLY, not tailnet-bounded)`);
});
