import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRoster, phoneEnabledAgents } from "@thicket/roster";

import { loadPhoneConfig, parsePhoneConfig, PhoneConfigError } from "./config.js";

const complete = {
  public_base_url: "https://phone.example.net",
  twilio: {
    account_sid: "AC" + "0".repeat(32),
    auth_token: "token",
    number: "+15550100002",
  },
  operator_numbers: ["+15550100001"],
  pin: "47290138",
  alerts: { channel: "C0BT7AFCMTR", bot_token: "xoxb-test" },
};

function refuses(document: unknown, pattern: RegExp): void {
  assert.throws(
    () => parsePhoneConfig(document, "phone.json"),
    (err: unknown) => {
      assert.ok(err instanceof PhoneConfigError);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

test("a complete config parses, and the roster beside it names no number", () => {
  const config = parsePhoneConfig(complete, "phone.json");
  assert.equal(config.pin, "47290138");
  assert.deepEqual(config.operator_numbers, ["+15550100001"]);
  assert.equal(config.alerts?.channel, "C0BT7AFCMTR");
  assert.deepEqual(config.lockout, { failed_calls: 5, window_seconds: 3600, cooldown_seconds: 3600 }, "the lockout defaults");
  assert.equal(parsePhoneConfig({ ...complete, lockout: { failed_calls: 2 } }, "phone.json").lockout.cooldown_seconds, 3600);

  // Every number the bridge knows comes from its own file: the roster's
  // phone section carries capability and spoken names only.
  const roster = parseRoster(
    JSON.stringify({
      agents: {
        hearth: {
          host: "home",
          user: "hearth",
          description: "An agent.",
          tag: "tag:thicket-hearth",
          harness: { type: "claude-agent-sdk", cwd: "/home/hearth", model: "claude-opus-5" },
          phone: { enabled: true, spokenName: "Hearth" },
        },
      },
    }),
  );
  assert.doesNotMatch(JSON.stringify(roster), /\+\d{7,}/);
  assert.deepEqual(
    phoneEnabledAgents(roster).map((a) => a.name),
    ["hearth"],
  );
});

function without(key: keyof typeof complete): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...complete };
  delete copy[key];
  return copy;
}

test("refuses to start without a PIN or without an allow-list", () => {
  refuses(without("pin"), /pin: /);
  refuses({ ...complete, pin: "1234" }, /pin: the PIN is exactly eight digits/);
  refuses(without("operator_numbers"), /operator_numbers: /);
  refuses({ ...complete, operator_numbers: [] }, /operator_numbers: at least one operator number is required/);
  refuses({ ...complete, operator_numbers: ["555-0100"] }, /operator_numbers\[0\]: must be an E\.164 number/);
});

test("a stray key is refused rather than silently ignored", () => {
  refuses({ ...complete, operator_number: "+15550100001" }, /operator_number/);
});

test("the file must be 0600, and is read from disk as JSON", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "phone.json");
  writeFileSync(path, JSON.stringify(complete));

  chmodSync(path, 0o644);
  assert.throws(
    () => loadPhoneConfig(path),
    (err: unknown) => {
      assert.ok(err instanceof PhoneConfigError);
      assert.match(err.message, /is mode 0644; it holds the PIN and tokens and must be 0600/);
      return true;
    },
  );

  chmodSync(path, 0o600);
  assert.equal(loadPhoneConfig(path).twilio.number, "+15550100002");

  assert.throws(
    () => loadPhoneConfig(join(dir, "missing.json")),
    (err: unknown) => err instanceof PhoneConfigError && /cannot be read/.test(err.message),
  );
  writeFileSync(path, "{not json", { mode: 0o600 });
  assert.throws(
    () => loadPhoneConfig(path),
    (err: unknown) => err instanceof PhoneConfigError && /is not JSON/.test(err.message),
  );
});

test("the socket may be handed to a group, and the field is either a name or absent", () => {
  // netd running as its own user is what lets a firewall rule drop the
  // bridge's egress and leave netd's alone; it can only dial the bridge's
  // socket if that socket is the pair's group's.
  assert.equal(parsePhoneConfig({ ...complete, socket_group: "thicket-phone" }, "phone.json").socket_group, "thicket-phone");
  assert.equal(parsePhoneConfig(complete, "phone.json").socket_group, undefined);
  refuses({ ...complete, socket_group: "" }, /socket_group/);
});

test("a credential the service manager materialised is read whatever mode it carries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-creds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "phone.json");
  writeFileSync(path, JSON.stringify(complete));
  // What systemd's LoadCredential produces where the unit names a group. The
  // directory it sits in is the manager's and only this service can enter it,
  // so the file's own bits say nothing about who else can read it.
  chmodSync(path, 0o440);

  assert.throws(() => loadPhoneConfig(path), /is mode 0440/);

  const previous = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = dir;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.CREDENTIALS_DIRECTORY;
    } else {
      process.env.CREDENTIALS_DIRECTORY = previous;
    }
  });
  assert.equal(loadPhoneConfig(path).pin, "47290138");

  // And only inside it: a path that merely starts with the same characters
  // is not in the directory.
  process.env.CREDENTIALS_DIRECTORY = dir + "-elsewhere";
  assert.throws(() => loadPhoneConfig(path), /is mode 0440/);
});
