import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  configDir,
  resolveRuntimeDir,
  runtimeDir,
  socketPath,
  stateDir,
} from "./paths.js";

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
    },
  );
});

test("empty or relative XDG values are ignored per the spec", () => {
  withEnv({ XDG_CONFIG_HOME: "", XDG_STATE_HOME: "relative/path" }, () => {
    assert.equal(configDir(), join(homedir(), ".config", "thicket"));
    assert.equal(stateDir(), join(homedir(), ".local", "state", "thicket"));
  });
});

const noDirs = () => false;
const allDirs = () => true;

test("runtimeDir prefers XDG_RUNTIME_DIR", () => {
  assert.equal(resolveRuntimeDir("/xdg/run", 1000, noDirs), "/xdg/run/thicket");
});

test("an empty or relative XDG_RUNTIME_DIR is ignored per the spec", () => {
  assert.equal(resolveRuntimeDir("", 1000, allDirs), "/run/user/1000/thicket");
  assert.equal(resolveRuntimeDir("run/user/1000", 1000, allDirs), "/run/user/1000/thicket");
});

// The daemons run under `systemd --user` and always have XDG_RUNTIME_DIR; a
// client spawned outside a login session does not. Both must land on the same
// socket path or the client connects to a path nothing ever bound.
test("without XDG_RUNTIME_DIR, an existing systemd runtime dir wins over the temp dir", () => {
  const probed: string[] = [];
  const dir = resolveRuntimeDir(undefined, 1000, (path) => {
    probed.push(path);
    return true;
  });
  assert.equal(dir, "/run/user/1000/thicket");
  assert.deepEqual(probed, ["/run/user/1000"]);
});

test("falls back to a uid-scoped temp dir where no systemd runtime dir exists", () => {
  assert.equal(resolveRuntimeDir(undefined, 1000, noDirs), join(tmpdir(), "thicket-1000"));
});

test("falls back to an unscoped temp dir where there is no uid", () => {
  assert.equal(resolveRuntimeDir(undefined, undefined, allDirs), join(tmpdir(), "thicket"));
});

test("runtimeDir and socketPath agree on the resolved directory", () => {
  assert.equal(socketPath("agentd"), join(runtimeDir(), "agentd.sock"));
});
