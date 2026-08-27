import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { chmodSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";

/** How agentd should acquire its listening socket. */
export type ListenTarget = { kind: "fd"; fd: number } | { kind: "path"; path: string };

const SD_LISTEN_FDS_START = 3;

/**
 * systemd socket activation: LISTEN_FDS counts fds starting at 3, and
 * LISTEN_PID names the intended recipient. Falls back to creating the
 * socket ourselves when not activated.
 */
export function resolveListenTarget(
  env: Record<string, string | undefined>,
  pid: number,
  socketPath: string,
): ListenTarget {
  const fds = Number(env.LISTEN_FDS);
  const listenPid = env.LISTEN_PID;
  const pidMatches =
    listenPid === undefined || listenPid === "" || Number(listenPid) === pid;
  if (Number.isInteger(fds) && fds >= 1 && pidMatches) {
    return { kind: "fd", fd: SD_LISTEN_FDS_START };
  }
  return { kind: "path", path: socketPath };
}

/**
 * Listens per the target. A self-created socket is mode 0600: agentd's
 * whole security model assumes only netd (same account) can reach it, so
 * a world-accessible socket is a configuration error, not a warning.
 */
export function listen(server: Server, target: ListenTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (target.kind === "fd") {
      server.listen({ fd: target.fd }, () => resolve());
      return;
    }
    mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 });
    if (existsSync(target.path)) {
      rmSync(target.path);
    }
    server.listen(target.path, () => {
      try {
        chmodSync(target.path, 0o600);
        assertNotWorldAccessible(target.path);
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export function assertNotWorldAccessible(path: string): void {
  const mode = statSync(path).mode;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `socket ${path} is group/world-accessible (mode ${(mode & 0o777).toString(8)}); ` +
        `agentd trusts the peer-tags header only because nothing but netd can connect`,
    );
  }
}
