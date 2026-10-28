import assert from "node:assert/strict";
import test from "node:test";

import {
  draftCommitMessageWithActiveModel,
  formatDraftResponseDiagnostics,
  inspectAssistantResponse,
  selectDraftMaxTokens,
  selectRetryDraftMaxTokens,
  shouldRetryDraftResponse,
} from "../src/commit-draft.ts";

function response(overrides) {
  return {
    stopReason: "stop",
    content: [],
    usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}

test("inspectAssistantResponse diagnoses empty content arrays", () => {
  const diagnostics = inspectAssistantResponse(response({ content: [] }));

  assert.equal(diagnostics.empty, true);
  assert.equal(diagnostics.thinkingOnly, false);
  assert.equal(diagnostics.lengthStopped, false);
  assert.deepEqual(diagnostics.contentTypes, []);
  assert.equal(diagnostics.textCharacterCount, 0);
  assert.equal(shouldRetryDraftResponse(diagnostics), true);
});

test("inspectAssistantResponse diagnoses thinking-only responses", () => {
  const diagnostics = inspectAssistantResponse(
    response({ content: [{ type: "thinking", thinking: "I should reason but never answer." }] }),
  );

  assert.equal(diagnostics.empty, true);
  assert.equal(diagnostics.thinkingOnly, true);
  assert.deepEqual(diagnostics.contentTypeCounts, { thinking: 1 });
  assert.match(formatDraftResponseDiagnostics(diagnostics), /contentTypes=thinking/);
  assert.equal(shouldRetryDraftResponse(diagnostics), true);
});

test("inspectAssistantResponse diagnoses length-stopped responses", () => {
  const diagnostics = inspectAssistantResponse(
    response({ stopReason: "length", content: [{ type: "thinking", thinking: "still reasoning" }] }),
  );

  assert.equal(diagnostics.lengthStopped, true);
  assert.equal(diagnostics.thinkingOnly, true);
  assert.equal(shouldRetryDraftResponse(diagnostics), true);
  assert.match(formatDraftResponseDiagnostics(diagnostics), /stopReason=length/);
});

test("inspectAssistantResponse accepts valid text content", () => {
  const diagnostics = inspectAssistantResponse(response({ content: [{ type: "text", text: "feat: add draft retries" }] }));

  assert.equal(diagnostics.empty, false);
  assert.equal(diagnostics.thinkingOnly, false);
  assert.equal(diagnostics.lengthStopped, false);
  assert.equal(diagnostics.textCharacterCount, "feat: add draft retries".length);
  assert.equal(diagnostics.usage.totalTokens, 10);
  assert.equal(shouldRetryDraftResponse(diagnostics, true), false);
});

test("draft token budgets respect model maximums and grow on retry", () => {
  assert.equal(selectDraftMaxTokens({ maxTokens: 512 }), 512);
  assert.equal(selectDraftMaxTokens({ maxTokens: 4096 }), 1024);
  assert.equal(selectRetryDraftMaxTokens({ maxTokens: 4096 }, 1024), 1536);
  assert.equal(selectRetryDraftMaxTokens({ maxTokens: 1200 }, 1024), 1200);
});

test("draftCommitMessageWithActiveModel fails clearly without an active model", async () => {
  await assert.rejects(() => draftCommitMessageWithActiveModel("prompt", { model: undefined }), /No active Pi model/);
});

test("draftCommitMessageWithActiveModel fails clearly without an API key", async () => {
  await assert.rejects(
    () =>
      draftCommitMessageWithActiveModel("prompt", {
        model: { provider: "fixture", id: "model" },
        modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "" }) },
      }),
    /No API key is available for fixture\/model/,
  );
});

test("draftCommitMessageWithActiveModel surfaces model registry errors", async () => {
  await assert.rejects(
    () =>
      draftCommitMessageWithActiveModel("prompt", {
        model: { provider: "fixture", id: "model" },
        modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "auth failed" }) },
      }),
    /auth failed/,
  );
});
