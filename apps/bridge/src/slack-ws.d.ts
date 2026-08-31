// The aliased ws package. The alias exists so Bun resolves the installed
// implementation instead of its own built-in, which ignores the proxy agent
// (spikes/bridge-egress/); the types are the same package's, under the name
// DefinitelyTyped publishes them.
declare module "slack-ws" {
  import WebSocket from "ws";

  export default WebSocket;
}
