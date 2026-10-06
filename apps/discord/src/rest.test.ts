import test from "node:test";
import assert from "node:assert/strict";

import { DiscordApiError, DiscordRest, InvalidResponseBreaker, multipart } from "./rest.js";

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A fetch that answers from a script and records what it was asked. */
function scriptedFetch(script: Scripted[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: init?.body });
    const next = script.shift();
    if (next === undefined) {
      throw new Error("script exhausted");
    }
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function clock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a call carries the bot token and parses the body", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: { id: "m1" } }]);
  const rest = new DiscordRest({ token: "tok", fetchImpl });

  const body = await rest.post<{ id: string }>("/channels/1/messages", { content: "hi" });

  assert.equal(body.id, "m1");
  assert.equal(calls[0]?.headers.authorization, "Bot tok");
  assert.equal(calls[0]?.headers["content-type"], "application/json");
  assert.equal(calls[0]?.url, "https://discord.com/api/v10/channels/1/messages");
});

test("an empty bucket is waited out before the next call on that route", async () => {
  const c = clock();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.7" }, body: {} },
    { status: 200, headers: { "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1" }, body: {} },
    { status: 200, headers: { "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1" }, body: {} },
  ]);
  const rest = new DiscordRest({ token: "tok", fetchImpl, now: c.now, sleep: c.sleep });

  await rest.patch("/channels/99999999999999999/messages/11111111111111111", { content: "a" });
  // Another message in the same channel shares the bucket: same major parameter.
  await rest.patch("/channels/99999999999999999/messages/22222222222222222", { content: "b" });
  // A send is a different route and is not held.
  await rest.post("/channels/99999999999999999/messages", { content: "c" });

  assert.deepEqual(c.sleeps, [700], "one wait, for the edit bucket's reset");
  assert.equal(calls.length, 3);
});

test("a 429 is waited out by retry_after and retried, up to the limit", async () => {
  const c = clock();
  const { fetchImpl, calls } = scriptedFetch([
    { status: 429, headers: { "x-ratelimit-scope": "user" }, body: { retry_after: 0.45, message: "slow down" } },
    { status: 200, body: { ok: true } },
    { status: 429, body: { retry_after: 0.3 } },
    { status: 429, body: { retry_after: 0.3 } },
  ]);
  const rest = new DiscordRest({ token: "tok", fetchImpl, now: c.now, sleep: c.sleep, maxRetries: 1 });

  const body = await rest.post<{ ok: boolean }>("/channels/1/messages", {});
  assert.equal(body.ok, true);
  assert.deepEqual(c.sleeps, [450]);

  await assert.rejects(
    () => rest.post("/channels/1/messages", {}),
    (err: unknown) => err instanceof DiscordApiError && err.status === 429,
  );
  assert.equal(calls.length, 4);
});

test("a refusal is a DiscordApiError carrying Discord's code and body", async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 400, body: { message: "Invalid Form Body", code: 50035, errors: { components: {} } } },
  ]);
  const rest = new DiscordRest({ token: "tok", fetchImpl });

  await assert.rejects(
    () => rest.post("/channels/1/messages", {}),
    (err: unknown) =>
      err instanceof DiscordApiError &&
      err.status === 400 &&
      err.code === 50035 &&
      /Invalid Form Body/.test(err.message),
  );
});

test("the breaker counts 401, 403 and 429 fleet-wide and refuses once tripped", async () => {
  const c = clock();
  const breaker = new InvalidResponseBreaker(2, 10_000, c.now);
  const { fetchImpl } = scriptedFetch([
    { status: 403, body: { message: "Missing Access", code: 50001 } },
    { status: 401, body: { message: "Unauthorized", code: 0 } },
    { status: 200, body: {} },
  ]);
  const a = new DiscordRest({ token: "a", fetchImpl, breaker, now: c.now, sleep: c.sleep });
  const b = new DiscordRest({ token: "b", fetchImpl, breaker, now: c.now, sleep: c.sleep });

  await assert.rejects(() => a.get("/channels/1"));
  await assert.rejects(() => b.get("/channels/2"));
  assert.equal(breaker.count(), 2);
  await assert.rejects(
    () => a.get("/channels/3"),
    (err: unknown) => err instanceof DiscordApiError && /breaker/.test(err.message),
  );
  c.advance(11_000);
  assert.equal(breaker.tripped(), false);
  await a.get("/channels/3");
});

test("the global budget holds the fifty-first call in a second", async () => {
  const c = clock();
  const script: Scripted[] = [];
  for (let i = 0; i < 51; i += 1) {
    script.push({ status: 200, body: {} });
  }
  const { fetchImpl } = scriptedFetch(script);
  const rest = new DiscordRest({ token: "tok", fetchImpl, now: c.now, sleep: c.sleep });

  for (let i = 0; i < 51; i += 1) {
    await rest.get(`/channels/${i}`);
  }

  assert.deepEqual(c.sleeps, [1000]);
});

test("multipart carries payload_json and each file under files[n]", () => {
  const mp = multipart({ content: "x", attachments: [{ id: 0, filename: "a.txt" }] }, [
    { name: "a.txt", bytes: new TextEncoder().encode("hello"), contentType: "text/plain" },
  ]);
  const text = new TextDecoder().decode(mp.body);
  const boundary = mp.contentType.split("boundary=")[1]!;

  assert.ok(text.startsWith(`--${boundary}\r\ncontent-disposition: form-data; name="payload_json"`));
  assert.ok(text.includes('name="files[0]"; filename="a.txt"\r\ncontent-type: text/plain\r\n\r\nhello\r\n'));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
});
