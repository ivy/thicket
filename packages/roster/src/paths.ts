import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const APP = "thicket";

// Per the XDG base directory spec, a variable that is unset, empty, or holds a
// relative path must be ignored in favor of the default.
function xdgDir(envVar: string): string | undefined {
  const value = process.env[envVar];
  if (value !== undefined && value !== "" && isAbsolute(value)) {
    return value;
  }
  return undefined;
}

/** Config: $XDG_CONFIG_HOME/thicket, default ~/.config/thicket. */
export function configDir(): string {
  return join(xdgDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), APP);
}

/** State: $XDG_STATE_HOME/thicket, default ~/.local/state/thicket. */
export function stateDir(): string {
  return join(
    xdgDir("XDG_STATE_HOME") ?? join(homedir(), ".local", "state"),
    APP,
  );
}

/**
 * Runtime: $XDG_RUNTIME_DIR/thicket. The spec defines no default; fall back
 * to a per-user directory under the OS temp dir.
 */
export function runtimeDir(): string {
  const base = xdgDir("XDG_RUNTIME_DIR");
  if (base !== undefined) {
    return join(base, APP);
  }
  const uid = process.getuid?.();
  return join(tmpdir(), uid === undefined ? APP : `${APP}-${uid}`);
}

/** Unix socket path for a component, e.g. socketPath("agentd"). */
export function socketPath(component: string): string {
  return join(runtimeDir(), `${component}.sock`);
}
