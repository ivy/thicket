#!/usr/bin/env node
import { createLogger } from "./logger.js";
import { run } from "./main.js";

const logger = createLogger();
run(undefined, logger).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
