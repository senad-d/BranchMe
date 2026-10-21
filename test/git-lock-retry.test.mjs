import assert from "node:assert/strict";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import test from "node:test";
import { runGit } from "../src/git.ts";

const ctx = { cwd: "/repo" };
const args = ["switch", "feature/target"];
const success = { stdout: "", stderr: "", code: 0, killed: false };
const lockFailure = {
  ...success,
  code: 128,
  stderr: "fatal: Unable to create '/repo/.git/refs/heads/target.lock': File exists\n",
};

function makePi(results, onExec = () => {}) {
  const calls = [];
  return {
    calls,
    async exec(command, commandArgs, options) {
      calls.push({ command, args: commandArgs, options });
      onExec();
      const result = results.shift();
      assert.ok(result, "unexpected extra Git attempt");
      return result;
    },
  };
}

test("Git retries a transient ref lock with identical argv, cwd, timeout and signal", async () => {
  const pi = makePi([lockFailure, success]);
  const controller = new AbortController();
  assert.equal(await runGit(pi, ctx, args, { timeout: 1234, signal: controller.signal, allowFailure: true }), success);
  assert.equal(pi.calls.length, 2);
  assert.deepEqual(pi.calls[0], {
    command: "git",
    args,
    options: { cwd: ctx.cwd, timeout: 1234, signal: controller.signal },
  });
  assert.deepEqual(pi.calls[1], pi.calls[0]);
});

test("Git returns success and ordinary allowed failures without retrying", async () => {
  const ordinaryFailure = { ...success, code: 1, stderr: "fatal: invalid reference: feature/target" };
  const pi = makePi([success, ordinaryFailure]);
  assert.equal(await runGit(pi, ctx, args), success);
  assert.equal(await runGit(pi, ctx, args, { allowFailure: true }), ordinaryFailure);
  assert.equal(pi.calls.length, 2);
  assert.equal(pi.calls[0].options.timeout, 30_000);
});

test("Git never retries a killed command, even with a lock error and allowFailure", async () => {
  const pi = makePi([{ ...lockFailure, killed: true }]);
  await assert.rejects(runGit(pi, ctx, args, { allowFailure: true }), /failed \(killed\).*target\.lock/u);
  assert.equal(pi.calls.length, 1);
});

test("Git stops at the original lock deadline and retains the lock error for allowed failures", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const pi = makePi([lockFailure, lockFailure], () => t.mock.timers.tick(5000));
  const result = await runGit(pi, ctx, args, { allowFailure: true });
  assert.equal(pi.calls.length, 2);
  assert.equal(result.code, 128);
  assert.equal(result.stderr, `${lockFailure.stderr.trimEnd()}\nThe lock was still held after waiting 10 s.`);
});

test("Git redacts tokens when a persistent lock exhausts its wait", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const pi = makePi([
    { ...lockFailure, stderr: "Unable to create '/repo/private-test-secret/HEAD.lock': File exists\n" },
  ], () => t.mock.timers.tick(10_000));
  await assert.rejects(runGit(pi, ctx, args, { tokens: ["private-test-secret"] }), (error) => {
    assert.match(error.message, /HEAD\.lock': File exists[\s\S]*after waiting 10 s\./u);
    assert.doesNotMatch(error.message, /private-test-secret/u);
    return true;
  });
  assert.equal(pi.calls.length, 1);
});

test("Git cancellation interrupts the lock wait without another mutation attempt", async () => {
  const controller = new AbortController();
  const pi = makePi([lockFailure]);
  const pending = runGit(pi, ctx, args, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await yieldToEventLoop();
  controller.abort();
  await rejected;
  assert.equal(pi.calls.length, 1);
});

test("Git does not retry a lock failure when the caller has already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const pi = makePi([lockFailure]);
  await assert.rejects(runGit(pi, ctx, args, { signal: controller.signal }), /target\.lock': File exists/u);
  assert.equal(pi.calls.length, 1);
});
