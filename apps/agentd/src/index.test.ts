import test from "node:test";
import assert from "node:assert/strict";

import { packageName, rosterDependency } from "./index.js";

test("exports the package name", () => {
  assert.equal(packageName, "@thicket/agentd");
});

test("imports a symbol from @thicket/roster", () => {
  assert.equal(rosterDependency, "@thicket/roster");
});
