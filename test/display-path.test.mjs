import assert from "node:assert/strict";
import test from "node:test";

import { formatDisplayPath } from "../src/truncation.ts";

test("formatDisplayPath escapes control characters for display", () => {
  assert.equal(formatDisplayPath("a\rb\nc\td\x7f"), String.raw`a\rb\nc\td\x7f`);
});
