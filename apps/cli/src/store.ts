import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Small JSON-file store under the thicket config dir. Secrets are written
 * mode 0600 and atomically (write-then-rename), because a provision run
 * dying mid-write must never strand the operator with a corrupt or
 * world-readable token file.
 */
export class FileStore {
  constructor(private readonly baseDir: string) {}

  path(name: string): string {
    return join(this.baseDir, name);
  }

  read<T>(name: string): T | undefined {
    try {
      return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  write(name: string, value: unknown, options: { secret?: boolean } = {}): void {
    const target = this.path(name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
      mode: options.secret ? 0o600 : 0o644,
    });
    chmodSync(tmp, options.secret ? 0o600 : 0o644);
    renameSync(tmp, target);
  }
}

/** app_id bookkeeping from previous provision runs. */
export interface ProvisionState {
  apps: Record<string, { appId: string }>;
}

export const PROVISION_STATE_FILE = "provision-state.json";
export const CONFIG_TOKEN_FILE = "slack-config-token.json";

/** The Slack app-configuration token pair. Expires 12h after issue. */
export interface ConfigTokenPair {
  token: string;
  refreshToken: string;
  /** Unix seconds expiry of `token`. */
  exp: number;
}
