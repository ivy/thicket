// Stand-in for netd's inbound side, for local development only.
//
// netd terminates tailnet TLS, asks WhoIs who called, strips any
// client-supplied X-Thicket-* headers, and stamps the verified tags before
// proxying to a unix socket. Without a tailnet there is nothing to verify,
// so this asserts an identity instead — which is exactly why it must never
// run anywhere real.
//
//   UPSTREAM=$XDG_RUNTIME_DIR/thicket/agentd.sock PEER_TAG=tag:thicket-bridge \
//     PORT=8791 node peer-tag-proxy.mjs
//
// Both directions need one: agents are reached at their agentd socket
// carrying the bridge's tag, and the bridge's file surface is reached at
// its own socket carrying the calling agent's tag.
import { createServer, request } from "node:http";

const UPSTREAM = process.env.UPSTREAM;
const PEER_TAG = process.env.PEER_TAG;
const PORT = Number(process.env.PORT ?? 8791);

if (UPSTREAM === undefined || PEER_TAG === undefined) {
  console.error("UPSTREAM (unix socket path) and PEER_TAG are required");
  process.exit(2);
}

createServer((req, res) => {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!key.toLowerCase().startsWith("x-thicket-")) {
      headers[key] = value;
    }
  }
  headers["x-thicket-peer-tags"] = PEER_TAG;
  const upstream = request(
    { socketPath: UPSTREAM, path: req.url, method: req.method, headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.statusCode = 502;
    res.end(String(err));
  });
  req.pipe(upstream);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`peer-tag proxy: 127.0.0.1:${PORT} -> ${UPSTREAM} as ${PEER_TAG}`);
});
