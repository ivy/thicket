import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const APP = "thicket";

// systemd creates and owns one of these per logged-in uid, and points
// XDG_RUNTIME_DIR at it.
const SYSTEMD_RUNTIME_ROOT = "/run/user";

// Per the XDG base directory spec, a variable that is unset, empty, or holds a
// relative path must be ignored in favor of the default.
function usableXdgValue(value: string | undefined): string | undefined {
  if (value !== undefined && value !== "" && isAbsolute(value)) {
    return value;
  }
  return undefined;
}

function xdgDir(envVar: string): string | undefined {
  return usableXdgValue(process.env[envVar]);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
 * Cache: $XDG_CACHE_HOME/thicket, default ~/.cache/thicket. Holds what can
 * be fetched again — attachments are here because the bridge can always
 * re-serve them, which is what makes discarding them safe.
 */
export function cacheDir(): string {
  return join(xdgDir("XDG_CACHE_HOME") ?? join(homedir(), ".cache"), APP);
}

/**
 * Resolve the runtime directory from its three inputs. Parameterized rather
 * than reading the environment directly so every branch is reachable from a
 * test without a real /run/user.
 *
 * The daemons run under `systemd --user`, which always sets XDG_RUNTIME_DIR. A
 * client does not: a process spawned outside a login session — an MCP server
 * started by an editor, a cron job — inherits nothing. Dropping straight to the
 * temp dir there would point the client at a socket path the daemon never bound,
 * so probe the directory systemd would have named before giving up on it.
 */
export function resolveRuntimeDir(
  xdgRuntimeDir: string | undefined,
  uid: number | undefined,
  dirExists: (path: string) => boolean,
): string {
  const base = usableXdgValue(xdgRuntimeDir);
  if (base !== undefined) {
    return join(base, APP);
  }
  if (uid !== undefined) {
    const systemd = join(SYSTEMD_RUNTIME_ROOT, String(uid));
    if (dirExists(systemd)) {
      return join(systemd, APP);
    }
  }
  // Last resort: no systemd runtime dir, as on macOS. The uid keeps two users
  // on one machine off each other's sockets in a world-writable directory.
  return join(tmpdir(), uid === undefined ? APP : `${APP}-${uid}`);
}

/** Runtime: $XDG_RUNTIME_DIR/thicket. The spec defines no default. */
export function runtimeDir(): string {
  return resolveRuntimeDir(
    process.env.XDG_RUNTIME_DIR,
    process.getuid?.(),
    isDirectory,
  );
}

/** Unix socket path for a component, e.g. socketPath("agentd"). */
export function socketPath(component: string): string {
  return join(runtimeDir(), `${component}.sock`);
}
