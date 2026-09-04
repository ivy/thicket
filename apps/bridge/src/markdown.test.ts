import test from "node:test";
import assert from "node:assert/strict";

import { advance, reopen, splitMarkdown, START, takeChunk } from "./markdown.js";

test("splitMarkdown prefers paragraph, then line, then space boundaries", () => {
  const paragraphs = "alpha alpha.\n\nbeta beta.\n\ngamma gamma.";
  assert.deepEqual(splitMarkdown(paragraphs, 20), ["alpha alpha.", "beta beta.", "gamma gamma."]);

  const lines = "one one one\ntwo two two\nthree three";
  assert.deepEqual(splitMarkdown(lines, 25), ["one one one\ntwo two two", "three three"]);

  const words = "aa bb cc dd ee ff";
  assert.deepEqual(splitMarkdown(words, 8), ["aa bb cc", "dd ee ff"]);

  assert.deepEqual(splitMarkdown("short", 100), ["short"], "short text passes through whole");
  assert.deepEqual(
    splitMarkdown("x".repeat(12), 5),
    ["xxxxx", "xxxxx", "xx"],
    "an unbroken run is hard-cut rather than looping",
  );
});

test("a code block split across pieces is closed and reopened", () => {
  const log = Array.from({ length: 8 }, (_, i) => `line ${i} of the log`).join("\n");
  const text = `Here is the log:\n\n\`\`\`ts\n${log}\n\`\`\`\n\nThat is all.`;
  const pieces = splitMarkdown(text, 90);

  assert.ok(pieces.length > 2, `the block spans several pieces (got ${pieces.length})`);
  for (const piece of pieces) {
    const fences = (piece.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `every piece closes what it opens: ${JSON.stringify(piece)}`);
    // A message has no trailing newline; the closing fence is its last line.
    assert.equal(advance(START, `${piece}\n`).fence, undefined, "no piece ends inside a block");
  }
  // Every line of the log still reads as code, in order, exactly once.
  const code = pieces
    .flatMap((p) => p.split("\n"))
    .filter((l) => l.startsWith("line "));
  assert.deepEqual(code, log.split("\n"));
  assert.ok(pieces[1]?.startsWith("```ts\n"), "the block reopens with its info string");
});

test("a fence longer than three, and a tilde fence, are reopened as themselves", () => {
  const body = Array.from({ length: 6 }, (_, i) => `row ${i}`).join("\n");
  for (const marker of ["````", "~~~"]) {
    const pieces = splitMarkdown(`${marker}sh\n${body}\n${marker}\n`, 30);
    assert.ok(pieces.length > 1);
    assert.ok(pieces[0]!.endsWith(marker), `closed with ${marker}`);
    assert.ok(pieces[1]!.startsWith(`${marker}sh\n`), `reopened as ${marker}sh`);
  }
});

test("an inner fence of a different run length is content, not a close", () => {
  const text = "````\n```\nstill inside\n```\n````\nafter";
  assert.equal(advance(START, "````\n```\nstill inside\n").fence?.marker, "````");
  const pieces = splitMarkdown(text, 20);
  for (const piece of pieces) {
    assert.equal(advance(START, `${piece}\n`).fence, undefined);
  }
  assert.ok(pieces.at(-1)!.endsWith("after"));
});

test("a cut inside a block keeps the indentation of the line it lands on", () => {
  const text = "```py\ndef f():\n    return 1\n    # a trailing comment that pushes past the budget\n```";
  const pieces = splitMarkdown(text, 40);
  assert.ok(pieces.length > 1);
  assert.ok(
    pieces.some((p) => p.split("\n").some((l) => l.startsWith("    return 1"))),
    `indentation survives the split: ${JSON.stringify(pieces)}`,
  );
});

test("no piece exceeds the budget", () => {
  const text = `intro\n\n\`\`\`\n${"payload ".repeat(200)}\n\`\`\`\n\noutro`;
  for (const max of [40, 97, 250]) {
    for (const piece of splitMarkdown(text, max)) {
      assert.ok(piece.length <= max, `piece of ${piece.length} fits in ${max}`);
    }
  }
});

test("takeChunk carries fence state across a mid-line delta", () => {
  // What a stream does: the fence arrives split across two deltas.
  const first = takeChunk("```ts\nconst x", 100, START);
  assert.equal(first.rest, "");
  assert.equal(first.cursor.fence?.info, "ts");
  assert.equal(first.cursor.partial, "const x");
  const second = takeChunk(" = 1;\n```\ndone", 100, first.cursor);
  assert.equal(second.cursor.fence, undefined, "the closing fence is seen across the delta");
});

test("reopen renders the line that resumes a block", () => {
  assert.equal(reopen(START), "");
  assert.equal(reopen(advance(START, "```ts\ncode\n")), "```ts\n");
  assert.equal(reopen(advance(START, "~~~\ncode\n")), "~~~\n");
});
