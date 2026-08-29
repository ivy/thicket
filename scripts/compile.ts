#!/usr/bin/env bun
/**
 * Compiles the TypeScript executables into standalone binaries.
 *
 * The deploy model is versioned artifacts pulled by mise: an agent account
 * gets a binary, not a checkout and a toolchain. One file per (executable,
 * platform) under `dist-bin/<target>/`.
 *
 *   bun run scripts/compile.ts                 # this machine's platform
 *   bun run scripts/compile.ts --all           # every platform the fleet has
 *   bun run scripts/compile.ts --target=bun-linux-x64
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Bun's own name for a compile target, per platform the fleet runs on. */
const TARGETS = ["bun-darwin-arm64", "bun-linux-x64"] as const;

const EXECUTABLES = [
  { name: "thicket", entry: "apps/cli/src/bin.ts" },
  { name: "thicket-agentd", entry: "apps/agentd/src/bin.ts" },
  { name: "thicket-bridge", entry: "apps/bridge/src/bin.ts" },
] as const;

function hostTarget(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${process.platform}-${arch}`;
}

function chosenTargets(argv: string[]): string[] {
  if (argv.includes("--all")) {
    return [...TARGETS];
  }
  const explicit = argv
    .filter((a) => a.startsWith("--target="))
    .map((a) => a.slice("--target=".length));
  return explicit.length > 0 ? explicit : [hostTarget()];
}

const outRoot = process.env.THICKET_DIST ?? "dist-bin";
let failed = false;

for (const target of chosenTargets(process.argv.slice(2))) {
  const outDir = join(outRoot, target);
  mkdirSync(outDir, { recursive: true });
  for (const { name, entry } of EXECUTABLES) {
    const outfile = join(outDir, name);
    const proc = Bun.spawnSync(
      ["bun", "build", "--compile", `--target=${target}`, "--outfile", outfile, entry],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (proc.exitCode !== 0) {
      process.stderr.write(`compile failed: ${name} for ${target}\n`);
      failed = true;
      continue;
    }
    process.stdout.write(`${outfile}\n`);
  }
}

process.exit(failed ? 1 : 0);
