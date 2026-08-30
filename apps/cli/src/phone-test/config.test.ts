import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPhoneTestConfig, parsePhoneTestConfig, PhoneTestConfigError } from "./config.js";

const MINIMAL = {
  twilio: { account_sid: "AC" + "0".repeat(32), auth_token: "token" },
  number: "+15550100001",
  pin: "31415926",
  public_base_url: "https://phone.example.net",
};

test("a minimal config parses and gets the defaults", () => {
  const config = parsePhoneTestConfig(JSON.stringify(MINIMAL), "x.json");
  assert.equal(config.path_prefix, "/operator");
  assert.equal(config.listen, "127.0.0.1:8797");
  assert.equal(config.from, undefined);
});

test("a missing field is named", () => {
  const withoutPin: Record<string, unknown> = { ...MINIMAL };
  delete withoutPin.pin;
  assert.throws(() => parsePhoneTestConfig(JSON.stringify(withoutPin), "x.json"), /pin/);
});

test("a wrong-shaped PIN is refused", () => {
  assert.throws(
    () => parsePhoneTestConfig(JSON.stringify({ ...MINIMAL, pin: "1234" }), "x.json"),
    /eight digits/,
  );
});

test("an unknown key is refused, so a typo cannot silently disable anything", () => {
  assert.throws(
    () => parsePhoneTestConfig(JSON.stringify({ ...MINIMAL, operator_numbers: [] }), "x.json"),
    PhoneTestConfigError,
  );
});

test("a base URL with a path is refused", () => {
  assert.throws(
    () => parsePhoneTestConfig(JSON.stringify({ ...MINIMAL, public_base_url: "https://x.example/operator" }), "x.json"),
    /https origin/,
  );
});

test("loading names the file when it is absent, and refuses a readable mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-test-config-"));
  const path = join(dir, "phone-test.json");
  try {
    assert.throws(() => loadPhoneTestConfig(path), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    writeFileSync(path, JSON.stringify(MINIMAL));
    chmodSync(path, 0o644);
    assert.throws(() => loadPhoneTestConfig(path), /0600/);
    chmodSync(path, 0o600);
    assert.equal(loadPhoneTestConfig(path).number, "+15550100001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
