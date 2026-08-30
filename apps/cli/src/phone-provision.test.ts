import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  desiredNumberSettings,
  HttpTwilioNumberApi,
  provisionNumber,
  readTwilioProvisioning,
  settingsDrift,
  TWILIO_FILE,
  type NumberSettings,
  type TwilioNumberApi,
} from "./phone-provision.js";
import { FileStore } from "./store.js";

const BASE = "https://thicket-phone.tail0000.ts.net";
const NUMBER = "+15550100002";

class FakeNumbers implements TwilioNumberApi {
  updates: Array<{ sid: string; settings: NumberSettings }> = [];
  constructor(public live: NumberSettings | undefined) {}
  async lookup() {
    return this.live === undefined ? undefined : { sid: "PN1", settings: this.live };
  }
  async update(sid: string, settings: NumberSettings) {
    this.updates.push({ sid, settings });
    this.live = settings;
  }
}

test("the desired settings are the bridge's webhooks, and drift names each field", () => {
  const desired = desiredNumberSettings(`${BASE}/`);
  assert.deepEqual(desired, {
    voiceUrl: `${BASE}/voice`,
    voiceMethod: "POST",
    statusCallback: `${BASE}/status`,
    statusCallbackMethod: "POST",
  });
  assert.deepEqual(settingsDrift(desired, desired), []);
  assert.deepEqual(settingsDrift({ ...desired, voiceUrl: "https://old.example/twiml", statusCallback: "" }, desired), [
    `voiceUrl: https://old.example/twiml → ${BASE}/voice`,
    `statusCallback: (unset) → ${BASE}/status`,
  ]);
});

test("a dry run shows the change and makes none; a real run makes it once", async () => {
  const api = new FakeNumbers({ voiceUrl: "https://old.example/twiml", voiceMethod: "POST", statusCallback: "", statusCallbackMethod: "" });
  const lines: string[] = [];
  const deps = { api, report: (l: string) => void lines.push(l) };

  assert.equal(await provisionNumber({ number: NUMBER, publicBaseUrl: BASE, dryRun: true }, deps), "would change");
  assert.match(lines[0]!, /^would point the phone number at the bridge: voiceUrl: https:\/\/old\.example\/twiml → .*\/voice; statusCallback: \(unset\) → .*\/status; statusCallbackMethod: \(unset\) → POST$/);
  assert.equal(api.updates.length, 0);

  assert.equal(await provisionNumber({ number: NUMBER, publicBaseUrl: BASE, dryRun: false }, deps), "changed");
  assert.equal(api.updates.length, 1);
  assert.equal(api.updates[0]?.sid, "PN1");
  assert.match(lines[1]!, /^pointed the phone number at the bridge/);

  assert.equal(await provisionNumber({ number: NUMBER, publicBaseUrl: BASE, dryRun: false }, deps), "up to date");
  assert.equal(api.updates.length, 1, "idempotent");
  assert.match(lines[2]!, /^phone number: up to date/);

  await assert.rejects(provisionNumber({ number: NUMBER, publicBaseUrl: BASE, dryRun: true }, { ...deps, api: new FakeNumbers(undefined) }), /does not own the number/);
});

test("the operator's twilio.json is read and checked, and its credentials become basic auth", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "twilio-prov-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  assert.equal(readTwilioProvisioning(store), undefined, "absent means no phone to provision");

  writeFileSync(join(dir, TWILIO_FILE), JSON.stringify({ account_sid: "AC1", number: NUMBER }), { mode: 0o600 });
  assert.throws(() => readTwilioProvisioning(store), /"public_base_url" is required/);
  writeFileSync(join(dir, TWILIO_FILE), JSON.stringify({ account_sid: "AC1", number: NUMBER, public_base_url: BASE }), { mode: 0o600 });
  assert.throws(() => readTwilioProvisioning(store), /needs api_key_sid \+ api_key_secret, or auth_token/);
  writeFileSync(join(dir, TWILIO_FILE), JSON.stringify({ account_sid: "AC1", api_key_sid: "SK1", api_key_secret: "s3", number: NUMBER, public_base_url: BASE }), { mode: 0o600 });
  const creds = readTwilioProvisioning(store)!;
  assert.equal(creds.number, NUMBER);

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("IncomingPhoneNumbers.json")) {
      return Response.json({ incoming_phone_numbers: [{ sid: "PN9", voice_url: "https://old", voice_method: "POST" }] });
    }
    return Response.json({ sid: "PN9" });
  }) as unknown as typeof fetch;
  const api = new HttpTwilioNumberApi(creds, fetchImpl);
  const live = await api.lookup(NUMBER);
  assert.equal(live?.sid, "PN9");
  assert.deepEqual(live?.settings, { voiceUrl: "https://old", voiceMethod: "POST", statusCallback: "", statusCallbackMethod: "" });
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Basic " + Buffer.from("SK1:s3").toString("base64"));
  assert.match(calls[0]!.url, /PhoneNumber=%2B15550100002$/);
  await api.update("PN9", desiredNumberSettings(BASE));
  assert.match(calls[1]!.url, /IncomingPhoneNumbers\/PN9\.json$/);
  assert.match(String(calls[1]?.init?.body), /VoiceUrl=https%3A%2F%2Fthicket-phone\.tail0000\.ts\.net%2Fvoice&VoiceMethod=POST&StatusCallback=.*%2Fstatus&StatusCallbackMethod=POST/);
});
