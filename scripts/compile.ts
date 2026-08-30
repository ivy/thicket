#!/usr/bin/env bun
/**
 * Compiles the TypeScript executables into standalone binaries.
 *
 * The deploy model is versioned artifacts pulled by mise: an agent account
 * gets a binary, not a checkout and a toolchain. One file per (executable,
 * platform) under `dist-bin/<platform>/`.
 *
 *   bun run scripts/compile.ts                    # this machine's platform
 *   bun run scripts/compile.ts --all              # every platform the fleet has
 *   bun run scripts/compile.ts --platform=linux-x64
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { PLATFORMS, hostPlatform, type Platform } from "./platforms.ts";

export const EXECUTABLES = [
  { name: "thicket", entry: "apps/cli/src/bin.ts" },
  { name: "thicket-agentd", entry: "apps/agentd/src/bin.ts" },
  { name: "thicket-bridge", entry: "apps/bridge/src/bin.ts" },
  { name: "thicket-phone", entry: "apps/phone/src/bin.ts" },
] as const;

export function chosenPlatforms(argv: string[]): Platform[] {
  if (argv.includes("--all")) {
    return [...PLATFORMS];
  }
  const named = argv
    .filter((a) => a.startsWith("--platform="))
    .map((a) => a.slice("--platform=".length));
  if (named.length > 0) {
    return named.map((name) => {
      const found = PLATFORMS.find((p) => p.name === name);
      if (found === undefined) {
        throw new Error(
          `unknown platform ${name}; the fleet has ${PLATFORMS.map((p) => p.name).join(", ")}`,
        );
      }
      return found;
    });
  }
  const host = hostPlatform();
  if (host === undefined) {
    throw new Error(
      `no fleet platform for ${process.platform}-${process.arch}; pass --platform=`,
    );
  }
  return [host];
}

/** Compiles every executable for one platform into `outDir`. Returns their paths. */
export function compileInto(platform: Platform, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  return EXECUTABLES.map(({ name, entry }) => {
    const outfile = join(outDir, name);
    const proc = Bun.spawnSync(
      [
        "bun",
        "build",
        "--compile",
        `--target=${platform.bunTarget}`,
        "--outfile",
        outfile,
        entry,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`compile failed: ${name} for ${platform.name}`);
    }
    return outfile;
  });
}

if (import.meta.main) {
  const outRoot = process.env.THICKET_DIST ?? "dist-bin";
  for (const platform of chosenPlatforms(process.argv.slice(2))) {
    for (const path of compileInto(platform, join(outRoot, platform.name))) {
      process.stdout.write(`${path}\n`);
    }
  }
}
