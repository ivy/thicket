#!/usr/bin/env node
import { thicketVersion } from "@thicket/roster";
import { run } from "./main.js";

// Answered before anything else, so a binary can be identified even when
// its config is missing or wrong — which is when the question is usually
// asked.
if (process.argv.includes("--version")) {
  process.stdout.write(thicketVersion() + "\n");
  process.exit(0);
}

run().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: err instanceof Error ? err.message : String(err),
    }) + "\n",
  );
  process.exit(1);
});
