#!/usr/bin/env bun
/**
 * Builds the release archives: one per platform, each holding every
 * executable an agent account installs under `bin/`.
 *
 *   bun run scripts/package.ts v0.1.0            # this machine's platform
 *   bun run scripts/package.ts v0.1.0 --all      # every platform the fleet has
 *
 * One asset per platform rather than one per binary: mise's autodetector
 * then has a single candidate to score, and four tools cannot end up
 * installed from four different releases into the same directory.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { chosenPlatforms, compileInto } from "./compile.ts";
import type { Platform } from "./platforms.ts";

const OUT_ROOT = process.env.THICKET_RELEASE_DIST ?? "dist-release";

function run(cmd: string[], env?: Record<string, string>): void {
  const proc = Bun.spawnSync(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`failed (${String(proc.exitCode)}): ${cmd.join(" ")}`);
  }
}

/** Stages `bin/` for one platform and tars it. Returns the archive path. */
function archive(platform: Platform, version: string): string {
  const stage = join(OUT_ROOT, `stage-${platform.name}`);
  rmSync(stage, { recursive: true, force: true });
  const bin = join(stage, "bin");
  compileInto(platform, bin);
  run(["go", "build", "-o", join(bin, "thicket-netd"), "./netd"], {
    // netd's dependencies are pure Go, so the release binary is static and
    // owes nothing to the builder's libc.
    CGO_ENABLED: "0",
    GOOS: platform.goos,
    GOARCH: platform.goarch,
  });

  // `<name>-<version>-<os>-<arch>.tar.gz`: the os and arch tokens sit on
  // word boundaries, which is what mise's asset matcher scores on.
  // The units and the SELinux module travel with the binaries they
  // describe: a policy that labels a path is only right for the layout it
  // shipped with, and an operator should never have to match a module to a
  // release by hand.
  cpSync("deploy/systemd", join(stage, "deploy", "systemd"), { recursive: true });
  cpSync("deploy/selinux", join(stage, "deploy", "selinux"), { recursive: true });
  rmSync(join(stage, "deploy", "selinux", "thicket.pp"), { force: true });
  rmSync(join(stage, "deploy", "selinux", "thicket.mod"), { force: true });

  const archivePath = join(OUT_ROOT, `thicket-${version}-${platform.name}.tar.gz`);
  run(["tar", "-czf", archivePath, "-C", stage, "bin", "deploy"]);
  rmSync(stage, { recursive: true, force: true });
  return archivePath;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  if (version === undefined) {
    process.stderr.write("usage: package.ts <version> [--all] [--platform=NAME]\n");
    process.exit(2);
  }
  mkdirSync(OUT_ROOT, { recursive: true });
  for (const platform of chosenPlatforms(args)) {
    process.stdout.write(`${archive(platform, version)}\n`);
  }
}
