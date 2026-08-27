import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveListenTarget } from "./listen.js";

test("socket activation: LISTEN_FDS with matching pid yields fd 3", () => {
  assert.deepEqual(
    resolveListenTarget({ LISTEN_FDS: "1", LISTEN_PID: "123" }, 123, "/run/agentd.sock"),
    { kind: "fd", fd: 3 },
  );
});

test("socket activation: missing LISTEN_PID still accepts the fd", () => {
  assert.deepEqual(resolveListenTarget({ LISTEN_FDS: "1" }, 999, "/run/agentd.sock"), {
    kind: "fd",
    fd: 3,
  });
});

test("pid mismatch means the fds are not ours: fall back to the path", () => {
  assert.deepEqual(
    resolveListenTarget({ LISTEN_FDS: "1", LISTEN_PID: "42" }, 999, "/run/agentd.sock"),
    { kind: "path", path: "/run/agentd.sock" },
  );
});

test("no activation env falls back to creating the socket", () => {
  assert.deepEqual(resolveListenTarget({}, 1, "/run/agentd.sock"), {
    kind: "path",
    path: "/run/agentd.sock",
  });
});
