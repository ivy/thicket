import test from "node:test";
import assert from "node:assert/strict";

import { assertAgentsConfigured } from "./main.js";

test("a config with agents passes", () => {
  assertAgentsConfigured({ agents: { lode: {} } }, "/c/bridge.json");
});

test("a config with no agents key names the file and the tokens", () => {
  assert.throws(
    () => assertAgentsConfigured({}, "/c/bridge.json"),
    (err: Error) => {
      assert.match(err.message, /\/c\/bridge\.json/);
      assert.match(err.message, /app_token/);
      assert.match(err.message, /bot_token/);
      return true;
    },
  );
});

test("an empty agents map is rejected too: it would connect to nothing", () => {
  assert.throws(() => assertAgentsConfigured({ agents: {} }, "/c/bridge.json"), /agents/);
});
