import assert from "node:assert/strict";
import test from "node:test";

import { appendTruncationNotice, truncateText } from "../src/truncation.ts";

test("truncateText reports no truncation when content fits", () => {
  const result = truncateText("one\ntwo", { maxLines: 5, maxBytes: 100, label: "sample" });

  assert.equal(result.text, "one\ntwo");
  assert.equal(result.metadata.truncated, false);
  assert.equal(result.notice, undefined);
});

test("truncateText applies a line limit with explicit metadata", () => {
  const result = truncateText("a\nb\nc\nd", { maxLines: 2, strategy: "head", label: "lines" });

  assert.equal(result.text, "a\nb");
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.originalLines, 4);
  assert.equal(result.metadata.outputLines, 2);
  assert.match(result.notice, /Truncated lines/);
});

test("truncateText applies a byte limit without splitting multibyte characters", () => {
  const result = truncateText("😀😀😀", { maxBytes: 8, strategy: "head", label: "emoji" });

  assert.equal(result.text, "😀😀");
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.originalBytes, 12);
  assert.equal(result.metadata.outputBytes, 8);
});

test("truncateText can preserve tail content", () => {
  const result = truncateText("a\nb\nc\nd", { maxLines: 2, strategy: "tail" });

  assert.equal(result.text, "c\nd");
  assert.equal(result.metadata.strategy, "tail");
});

test("truncateText returns empty output for a zero line limit", () => {
  const result = truncateText("a\nb", { maxLines: 0, strategy: "tail" });

  assert.equal(result.text, "");
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.outputLines, 0);
});

test("appendTruncationNotice adds a model-facing notice when truncated", () => {
  const result = truncateText("a\nb\nc", { maxLines: 1, label: "context" });
  const output = appendTruncationNotice(result);

  assert.match(output, /^a\n\n\[Truncated context:/);
});
