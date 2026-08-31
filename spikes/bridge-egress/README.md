# Bridge egress under Bun

Can the bridge's outbound legs be routed through netd's egress socket, so the
process can give up its own network namespace? Run it:

```sh
mise exec -- bun run spikes/bridge-egress/spike.ts
```

The stand-in answers on `slack-stand-in.invalid` — a name that cannot resolve —
so a leg that reaches it went through the CONNECT tunnel and a leg that fails
went around it. No counting needed to tell them apart, though the proxy counts
CONNECTs anyway.

## What it found

| Leg | Result |
|---|---|
| `@slack/web-api` `WebClient` with `agent` | tunnelled |
| `ws` imported from the installed package, with `agent` | tunnelled |
| bare `"ws"` specifier with `agent` | **bypassed** — dialed directly |
| `@slack/socket-mode` `SocketModeClient` with `clientOptions.agent` | **bypassed** on the socket; its Web API call tunnels |

Bun ships its own `ws`, and the built-in wins over the installed package for
the bare specifier. It ignores the `agent` option entirely — `createConnection`
is never called — so a WebSocket asked to go through a proxy quietly goes
straight out instead. Socket Mode reuses `clientOptions.agent` for its socket
(`SocketModeClient.js`, `httpAgent: this.webClientOptions.agent`), which is why
its Web API call tunnels while the socket it opens from the answer does not.

Nothing reaches around the built-in from the outside:

- `ws/index.js` and `ws/lib/websocket.js` are unresolvable — "Cannot find
  package 'ws'" — even from inside `@slack/socket-mode`, where the symlink is
  right there. So a patched subpath import is not a way out.
- A `Bun.plugin` `onResolve` on `/^ws$/`, preloaded, is not consulted.
- `bun build --compile` behaves the same as `bun run`: one module bundled, the
  built-in linked. At least dev and release agree.

## What does work

An **npm alias** gives the package a specifier Bun has no built-in for:

```jsonc
// apps/bridge/package.json
"dependencies": { "slack-ws": "npm:ws@^8.21.3" }
```

```
import WS from "slack-ws"  →  bun run:   createConnection calls: 1
                              compiled:  15 modules bundled, createConnection calls: 1
```

So the fix is not to talk the library into tunnelling — it cannot — but to own
the socket. `apps/bridge/src/socket.ts` already has the seam: `SocketishClient`
is what `SlackSocketConnection` drives, and the wrapper around it already
supervises recovery itself, because the library's hidden retries were their own
problem (see the `@slack/socket-mode` row in `docs/reference.md`). A Socket
Mode client of our own is `apps.connections.open` through the egress fetch,
then an aliased `ws` with the tunnelling agent, then hello / envelope / ack.

## Files

- `spike.ts` — the stand-in (HTTPS + WebSocket), a CONNECT proxy on a unix
  socket, a tunnelling `https.Agent`, and the four scenarios above.
