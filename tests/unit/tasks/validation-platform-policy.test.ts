import assert from "node:assert/strict";
import test from "node:test";
import { CoreError } from "../../../src/core/errors.js";
import { ControlledPatchValidationService } from "../../../src/tasks/controlled-patch-validation-service.js";
import type { ValidationProfile } from "../../../src/tasks/validation-profile-store.js";

// Policy tests use explicit platforms and recording ports, not simulated native
// Windows process evidence. Native MCP/platform coverage is a separate gate.
const proposal = { workspaceId: "w", workspaceRoot: "/fixture", baseHead: "a".repeat(40), patch: "fixture patch" };
const profile: ValidationProfile = { preparation: [], validation: [{ name: "check", argv: ["fixture-check"] }],
  defaultStepTimeoutSeconds: 600, totalTimeoutSeconds: 1200 };

function fixture(platform: NodeJS.Platform, baseHead: string | null = proposal.baseHead, configured = true) {
  const effects: string[] = [];
  const patch = { ...proposal, baseHead };
  // Reflect permits this regression to execute against the previous constructor
  // too: its missing platform policy ignores the last argument and wrongly runs.
  const service = Reflect.construct(ControlledPatchValidationService, [
    { resolve: () => { effects.push("resolve"); return proposal.workspaceRoot; } },
    { validationProposal: (id: string) => {
      if (id !== "known") throw new CoreError("INVALID_STATE_TRANSITION"); return patch;
    }, preflightValidationProposal: async () => { effects.push("git-preflight"); return patch; } },
    { get: async () => { effects.push("profile-read"); return configured ? profile : undefined; },
      configure: async () => { effects.push("configure"); return profile; } },
    { run: async ({ argv }: { argv: string[] }) => {
      effects.push(argv[0] === "git" ? "git-process" : "profile-process");
      return { kind: "exit", exitCode: 0, durationMs: 0, outputTail: "" };
    } },
    () => 1000,
    async () => { effects.push("temporary-parent"); return "/owned-temporary"; },
    async () => { effects.push("remove-parent"); },
    undefined,
    platform,
  ]) as ControlledPatchValidationService;
  return { service, effects, patch };
}

for (const [label, head, configured] of [
  ["configured profile", proposal.baseHead, true],
  ["missing profile", proposal.baseHead, false],
  ["unborn proposal", null, true],
] as const) {
  test(`win32 policy refuses ${label} before profile reads, Git preflight, processes or temporary state`, async () => {
    const { service, effects, patch } = fixture("win32", head, configured);
    assert.deepEqual(await service.validate("known"), {
      status: "INCOMPLETE", patch_task_id: "known", workspace_id: "w", base_head: patch.baseHead,
      total_duration_ms: 0, steps: [], cleanup: "success", reason: "unsupported_platform",
    });
    assert.deepEqual(effects, []);
    assert.equal((await service.validate("known")).reason, "unsupported_platform");
    assert.deepEqual(effects, [], "repeated requests must not start validation either");
  });
}

test("win32 policy preserves unknown-proposal errors and profile configuration", async () => {
  const { service, effects } = fixture("win32");
  await assert.rejects(service.validate("missing"), (e: unknown) => e instanceof CoreError && e.code === "INVALID_STATE_TRANSITION");
  assert.deepEqual(effects, []);
  assert.deepEqual(await service.configure("w", profile), profile);
  assert.deepEqual(effects, ["resolve", "configure"]);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`${platform} policy still executes the configured validation and cleanup`, async () => {
    const { service, effects } = fixture(platform);
    const result = await service.validate("known");
    assert.equal(result.status, "PASS"); assert.equal(result.cleanup, "success");
    assert.equal(result.steps[0]?.name, "check");
    assert.deepEqual(effects, ["profile-read", "resolve", "git-preflight", "temporary-parent",
      "git-process", "git-process", "profile-process", "git-process", "remove-parent"]);
  });
}
