import test from "node:test";
import assert from "node:assert/strict";

import { CardEditor } from "./editor.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("deltas to one card coalesce into the latest body, one flush per interval", async () => {
  const flushed: [string, string, unknown][] = [];
  const editor = new CardEditor({
    intervalMs: 30,
    flush: async (channel, messageId, body) => {
      flushed.push([channel, messageId, body]);
    },
  });

  editor.schedule("c", "m1", "a");
  editor.schedule("c", "m1", "ab");
  editor.schedule("c", "m1", "abc");
  await wait(10);
  assert.deepEqual(flushed, [["c", "m1", "abc"]], "the first flush is immediate and carries the latest");

  editor.schedule("c", "m1", "abcd");
  editor.schedule("c", "m1", "abcde");
  await wait(10);
  assert.equal(flushed.length, 1, "within the interval nothing more goes out");
  await wait(40);
  assert.deepEqual(flushed.at(-1), ["c", "m1", "abcde"]);
  assert.equal(flushed.length, 2);
});

test("two cards in one channel share the lane round-robin; another channel has its own", async () => {
  const flushed: [string, string][] = [];
  const editor = new CardEditor({
    intervalMs: 30,
    flush: async (channel, messageId) => {
      flushed.push([channel, messageId]);
    },
  });

  editor.schedule("c", "m1", 1);
  editor.schedule("c", "m2", 1);
  editor.schedule("d", "m3", 1);
  await wait(10);
  assert.deepEqual(flushed, [
    ["c", "m1"],
    ["d", "m3"],
  ]);
  await wait(40);
  assert.deepEqual(flushed.at(-1), ["c", "m2"]);
});

test("settle waits for the card's latest body to reach the API", async () => {
  const flushed: unknown[] = [];
  const editor = new CardEditor({
    intervalMs: 30,
    flush: async (_c, _m, body) => {
      flushed.push(body);
    },
  });
  editor.schedule("c", "m1", "first");
  await wait(5);
  await editor.settle("c", "m1", "final");
  assert.deepEqual(flushed, ["first", "final"]);
  assert.equal(editor.pendingCount, 0);
});

test("a flush that throws does not wedge the lane", async () => {
  let calls = 0;
  const editor = new CardEditor({
    intervalMs: 10,
    flush: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("refused");
      }
    },
  });
  editor.schedule("c", "m1", 1);
  await wait(5);
  editor.schedule("c", "m2", 1);
  await wait(30);
  assert.equal(calls, 2);
});

test("forget drops a card's pending edit and releases anyone waiting", async () => {
  const editor = new CardEditor({ intervalMs: 1000, flush: async () => {} });
  editor.schedule("c", "m1", 1);
  await wait(5);
  editor.schedule("c", "m1", 2);
  const settled = editor.settle("c", "m1");
  editor.forget("c", "m1");
  await settled;
  assert.equal(editor.pendingCount, 0);
});
