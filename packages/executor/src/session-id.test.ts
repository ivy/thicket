import test from "node:test";
import assert from "node:assert/strict";

import { deriveSessionId, uuidv5, THICKET_NAMESPACE } from "./session-id.js";

test("same (channel_id, thread_ts) yields a byte-identical session ID", () => {
  const a = deriveSessionId("C0123456789", "1724650000.000100");
  const b = deriveSessionId("C0123456789", "1724650000.000100");
  assert.equal(a, b);
  // Pinned constant: derivation must be stable across processes and
  // releases, or existing session transcripts become unreachable.
  assert.equal(a, uuidv5("C0123456789:1724650000.000100", THICKET_NAMESPACE));
  assert.equal(a, "6c196258-f3c4-5943-9503-edc4f7980faf");
});

test("distinct threads yield distinct IDs", () => {
  assert.notEqual(
    deriveSessionId("C0123456789", "1724650000.000100"),
    deriveSessionId("C0123456789", "1724650000.000200"),
  );
  assert.notEqual(
    deriveSessionId("C0123456789", "1724650000.000100"),
    deriveSessionId("C9999999999", "1724650000.000100"),
  );
});

test("output is a valid RFC 4122 v5 UUID", () => {
  const id = deriveSessionId("C1", "2.3");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("known RFC 4122 v5 test vector", () => {
  // uuidv5(DNS namespace, "www.example.com") from RFC 4122 appendix / python uuid5
  assert.equal(
    uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    "2ed6657d-e927-568b-95e1-2665a8aea6a2",
  );
});
