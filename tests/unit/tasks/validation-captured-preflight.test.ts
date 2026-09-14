import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { ValidationProcessRunner } from "../../../src/tasks/validation-process-runner.js";
import { validationFixture } from "../../helpers/validation-run-fixture.js";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

test("captured preflight uses the service-owned Git port after live task/proposal view disappears", async (t) => {
  const f = await validationFixture(t);
  const captured = f.patches.validationProposal(f.patchTaskId);
  t.mock.method(f.tasks, "result", () => undefined);
  assert.throws(() => f.patches.validationProposal(f.patchTaskId));
  const method = (f.patches as any).preflightCapturedValidationProposal;
  assert.equal(typeof method, "function");
  const commands: readonly string[][] = [];
  const runner = new ValidationProcessRunner();
  await method.call(f.patches, captured, async (cwd: string, args: readonly string[], input?: string) => {
    (commands as string[][]).push([...args]);
    const out = await runner.runSupervised({ argv: ["git", ...args], cwd, timeoutMs: 5000, ...(input === undefined ? {} : { input }) }, { signal: new AbortController().signal });
    assert.equal(out.kind, "exit"); assert.equal(out.disposition, "quiescent");
    return { code: out.kind === "exit" ? out.exitCode : -1, stdout: out.stdout };
  });
  assert.ok(commands.some(args => args[0] === "apply" && args.includes("--check")));
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(await fs.readFile(join(f.workspace, "note.txt"), "utf8"), "before\n");
});

test("captured preflight keeps dirty-worktree and exact base checks through the injected Git port", async (t) => {
  const f = await validationFixture(t);
  const captured = f.patches.validationProposal(f.patchTaskId);
  const method = (f.patches as any).preflightCapturedValidationProposal;
  assert.equal(typeof method, "function");
  const runner = new ValidationProcessRunner();
  const execute = async (cwd: string, args: readonly string[], input?: string) => {
    const out = await runner.runSupervised({ argv: ["git", ...args], cwd, timeoutMs: 5000, ...(input === undefined ? {} : { input }) }, { signal: new AbortController().signal });
    if (out.kind !== "exit" || out.disposition !== "quiescent" || out.stdoutTruncated) throw new Error("preflight infrastructure");
    return { code: out.exitCode, stdout: out.stdout };
  };
  await fs.writeFile(join(f.workspace, "note.txt"), "different\n");
  await assert.rejects(method.call(f.patches, captured, execute), { code: "WORKSPACE_PRECONDITION_FAILED" });
  await fs.writeFile(join(f.workspace, "note.txt"), "before\n");
  await assert.rejects(method.call(f.patches, { ...captured, baseHead: "0".repeat(40) }, execute), { code: "WORKSPACE_PRECONDITION_FAILED" });
});
