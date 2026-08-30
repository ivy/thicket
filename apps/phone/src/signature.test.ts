import test from "node:test";
import assert from "node:assert/strict";

import { signatureValid, twilioSignature } from "./signature.js";

test("signs the URL plus sorted params, and compares in constant time", () => {
  const token = "12345";
  // The worked example from Twilio's webhook security page.
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  assert.equal(twilioSignature(token, url, params), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  assert.ok(signatureValid(token, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="));
  assert.ok(!signatureValid(token, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ"), "one byte short");
  assert.ok(!signatureValid(token, url, params, undefined));
  assert.ok(!signatureValid("other", url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="));
  assert.equal(twilioSignature(token, "wss://phone.example.net/relay/x"), twilioSignature(token, "wss://phone.example.net/relay/x", undefined));
});
