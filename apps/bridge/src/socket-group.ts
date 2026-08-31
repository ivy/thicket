import { chmodSync, chownSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Give a unix socket to a group, so a process running as another user can
 * reach it.
 *
 * The default everywhere is 0600: the socket's owner and nobody else. This
 * widens it by exactly one step, and only when asked, because it is what
 * lets the two halves of a contained deployment be different unix users —
 * the one that must have no network, and the one that must have one. A
 * firewall rule can tell those apart only if they are different uids.
 */
export function shareSocketWithGroup(path: string, group: string | undefined): void {
  if (group === undefined || group === "") {
    chmodSync(path, 0o600);
    return;
  }
  // The owner is passed back rather than -1: "leave it alone" is a Node
  // convention that Bun answers with EINVAL.
  chownSync(path, statSync(path).uid, gidOf(group));
  chmodSync(path, 0o660);
}

/**
 * A group name or a numeric gid. A deployment that creates the group in the
 * same run may not have a resolvable name when it renders config, so the
 * number is not a fallback for a mistake — it is a supported form.
 */
function gidOf(group: string): number {
  const numeric = Number(group);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }
  let out: string;
  try {
    out = execFileSync("getent", ["group", group], { encoding: "utf8" });
  } catch {
    throw new Error(`socket_group "${group}": no such group on this host`);
  }
  const gid = Number(out.split(":")[2]);
  if (!Number.isInteger(gid)) {
    throw new Error(`socket_group "${group}": could not read a gid from "${out.trim()}"`);
  }
  return gid;
}
