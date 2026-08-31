#!/usr/bin/env node
import { thicketVersion } from "@thicket/roster";
import { createLogger } from "./logger.js";
import { run } from "./main.js";

// Answered before anything else, so a binary can be identified even when
// its config is missing or wrong — which is when the question is usually
// asked.
if (process.argv.includes("--version")) {
  process.stdout.write(thicketVersion() + "\n");
  process.exit(0);
}

const logger = createLogger();
run(undefined, logger).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
