import test from "node:test";
import assert from "node:assert/strict";

import { packageName } from "./index.js";

test("exports the package name", () => {
  assert.equal(packageName, "@thicket/cli");
});
