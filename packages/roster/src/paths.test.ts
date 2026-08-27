import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { configDir, runtimeDir, socketPath, stateDir } from "./paths.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("helpers honor XDG_* when set", () => {
  withEnv(
    {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_STATE_HOME: "/xdg/state",
      XDG_RUNTIME_DIR: "/xdg/run",
    },
    () => {
      assert.equal(configDir(), "/xdg/config/thicket");
      assert.equal(stateDir(), "/xdg/state/thicket");
      assert.equal(runtimeDir(), "/xdg/run/thicket");
      assert.equal(socketPath("agentd"), "/xdg/run/thicket/agentd.sock");
    },
  );
});

test("helpers fall back when XDG_* unset", () => {
  withEnv(
    {
      XDG_CONFIG_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_RUNTIME_DIR: undefined,
    },
    () => {
      assert.equal(configDir(), join(homedir(), ".config", "thicket"));
      assert.equal(stateDir(), join(homedir(), ".local", "state", "thicket"));
      const uid = process.getuid?.();
      assert.equal(
        runtimeDir(),
        join(tmpdir(), uid === undefined ? "thicket" : `thicket-${uid}`),
      );
    },
  );
});

test("empty or relative XDG values are ignored per the spec", () => {
  withEnv({ XDG_CONFIG_HOME: "", XDG_STATE_HOME: "relative/path" }, () => {
    assert.equal(configDir(), join(homedir(), ".config", "thicket"));
    assert.equal(stateDir(), join(homedir(), ".local", "state", "thicket"));
  });
});
