#!/usr/bin/env node
import { run } from "./main.js";

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
