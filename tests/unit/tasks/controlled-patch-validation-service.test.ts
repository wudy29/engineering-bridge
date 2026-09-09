import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isolateGitLineEndings } from "../../helpers/git-fixture.js";

import { CoreError } from "../../../src/core/errors.js";
import {
  ControlledPatchService,
  type ControlledPatchValidationProposal
} from "../../../src/tasks/controlled-patch-service.js";
import {
  ControlledPatchValidationService,
  type CleanupDeadlineTimer
} from "../../../src/tasks/controlled-patch-validation-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import type {
  ValidationProfile,
  ValidationProfileStore
} from "../../../src/tasks/validation-profile-store.js";
import {
  ValidationProcessRunner,
  type ValidationProcessOutcome,
  type ValidationProcessRequest
} from "../../../src/tasks/validation-process-runner.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const COMMIT_PROPOSAL: ControlledPatchValidationProposal = {
  workspaceId: "workspace-a",
  workspaceRoot: "/workspaces/workspace-a",
  baseHead: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  patch: [
    "diff --git a/note.txt b/note.txt",
    "index 5f24e3d..2f1a4b9 100644",
    "--- a/note.txt",
    "+++ b/note.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after"
  ].join("\n")
};

const UNBORN_PROPOSAL: ControlledPatchValidationProposal = {
  ...COMMIT_PROPOSAL,
  baseHead: null
};

const REAL_PATCH = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

const PROFILE: ValidationProfile = {
  preparation: [
    { name: "install", argv: ["npm", "ci", "--ignore-scripts"] },
    { name: "build", argv: ["npm", "run", "build"] }
  ],
  validation: [
    { name: "test", argv: ["npm", "test"], timeoutSeconds: 90 },
    { name: "lint", argv: ["npm", "run", "lint"] }
  ],
  defaultStepTimeoutSeconds: 600,
  totalTimeoutSeconds: 1200
};

const DEFAULT_OUTCOME: ValidationProcessOutcome = {
  kind: "exit",
  exitCode: 0,
  durationMs: 1,
  outputTail: ""
};

class FakeControlledPatchService {
  preflightError: unknown = undefined;
  preflightCalls = 0;

  constructor(readonly proposal: ControlledPatchValidationProposal) {}

  validationProposal(_patchTaskId: string): ControlledPatchValidationProposal {
    return this.proposal;
  }

  async preflightValidationProposal(
    _patchTaskId: string
  ): Promise<ControlledPatchValidationProposal> {
    this.preflightCalls++;
    if (this.preflightError !== undefined) {
      throw this.preflightError;
    }
    return this.proposal;
  }
}

class FakeProfileStore {
  getCalls = 0;

  constructor(readonly profile: ValidationProfile | undefined) {}

  async get(_workspaceId: string): Promise<ValidationProfile | undefined> {
    this.getCalls++;
    return this.profile;
  }
}

class FakeValidationProcessRunner {
  readonly invocations: ValidationProcessRequest[] = [];
  readonly overrides = new Map<string, ValidationProcessOutcome>();
  readonly prefixOverrides: Array<{
    readonly prefix: string;
    readonly outcome:
      | ValidationProcessOutcome
      | Promise<ValidationProcessOutcome>;
  }> = [];

  constructor(
    private readonly fallback?: ValidationProcessRunner
  ) {}

  async run(request: ValidationProcessRequest): Promise<ValidationProcessOutcome> {
    this.invocations.push(request);
    const key = request.argv.join(" ");
    const exact = this.overrides.get(key);
    if (exact !== undefined) {
      return exact;
    }
    const prefixMatch = this.prefixOverrides.find((entry) =>
      key.startsWith(entry.prefix)
    );
    if (prefixMatch !== undefined) {
      return prefixMatch.outcome;
    }
    if (this.fallback !== undefined) {
      return this.fallback.run(request);
    }
    return DEFAULT_OUTCOME;
  }
}

class ManualCleanupDeadlineTimer implements CleanupDeadlineTimer {
  setCount = 0;
  private nextId = 1;
  private scheduled:
    | {
        readonly handle: NodeJS.Timeout;
        readonly callback: () => void;
        readonly delayMs: number;
      }
    | undefined;

  get pendingCount(): number {
    return this.scheduled === undefined ? 0 : 1;
  }

  set(callback: () => void, delayMs: number): NodeJS.Timeout {
    this.setCount++;
    const handle = this.nextId++ as unknown as NodeJS.Timeout;
    this.scheduled = { handle, callback, delayMs };
    return handle;
  }

  clear(handle: NodeJS.Timeout): void {
    if (this.scheduled?.handle === handle) {
      this.scheduled = undefined;
    }
  }

  fire(): number {
    assert.notEqual(this.scheduled, undefined);
    const scheduled = this.scheduled!;
    this.scheduled = undefined;
    scheduled.callback();
    return scheduled.delayMs;
  }
}

type TempParentFactory = (() => Promise<string>) & {
  readonly created: readonly string[];
};

function makeTempParent(): TempParentFactory {
  const created: string[] = [];
  const factory = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "engineering-bridge-validation-"));
    created.push(dir);
    return dir;
  };
  return Object.assign(factory, { created });
}

interface ValidationHarness {
  service: ControlledPatchValidationService;
  patches: FakeControlledPatchService;
  store: FakeProfileStore;
  runner: FakeValidationProcessRunner;
  tempParent: TempParentFactory;
}

function makeHarness(options: {
  proposal: ControlledPatchValidationProposal;
  profile: ValidationProfile | undefined;
  preflightError?: unknown;
  runnerOverrides?: ReadonlyMap<string, ValidationProcessOutcome>;
  nowMs?: () => number;
  removeParent?: (temporaryParent: string) => Promise<void>;
  cleanupDeadlineTimer?: CleanupDeadlineTimer;
}): ValidationHarness {
  const patches = new FakeControlledPatchService(options.proposal);
  if (options.preflightError !== undefined) {
    patches.preflightError = options.preflightError;
  }
  const store = new FakeProfileStore(options.profile);
  const runner = new FakeValidationProcessRunner();
  for (const [command, outcome] of options.runnerOverrides ?? []) {
    runner.overrides.set(command, outcome);
  }
  const tempParent = makeTempParent();
  const registry = {
    resolve: (workspaceId: string) => "/workspaces/" + workspaceId
  } as unknown as RegisteredWorkspaceRegistry;
  const service = new ControlledPatchValidationService(
    registry,
    patches as unknown as ControlledPatchService,
    store as unknown as ValidationProfileStore,
    runner as unknown as ValidationProcessRunner,
    options.nowMs,
    tempParent,
    options.removeParent,
    options.cleanupDeadlineTimer
  );
  return { service, patches, store, runner, tempParent };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "engineering-bridge-validation-repo-"))
  );
  git(root, "init", "-q");
  isolateGitLineEndings(root);
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "note.txt"), "before\n");
  git(root, "add", "note.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function realProfile(
  validation: ValidationProfile["validation"]
): ValidationProfile {
  return {
    preparation: [],
    validation,
    defaultStepTimeoutSeconds: 30,
    totalTimeoutSeconds: 60
  };
}

async function makeRealValidationHarness(
  profile: ValidationProfile,
  runner: ValidationProcessRunner | FakeValidationProcessRunner =
    new ValidationProcessRunner()
) {
  const root = repository();
  const stateParent = mkdtempSync(
    join(tmpdir(), "engineering-bridge-validation-state-")
  );
  const stateFilePath = join(stateParent, "controlled-patches.json");
  const registry = new RegisteredWorkspaceRegistry([
    { id: "workspace", root }
  ]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => {
      throw new Error("submitted proposals must not execute");
    }
  }));
  const patches = new ControlledPatchService(
    registry,
    tasks,
    undefined,
    stateFilePath
  );
  const head = git(root, "rev-parse", "HEAD").trim();
  const submitted = await patches.submit({
    workspace_id: "workspace",
    base_head: head,
    diff: REAL_PATCH
  });
  const store = new FakeProfileStore(profile);
  const tempParent = makeTempParent();
  const service = new ControlledPatchValidationService(
    registry,
    patches,
    store as unknown as ValidationProfileStore,
    runner as unknown as ValidationProcessRunner,
    undefined,
    tempParent
  );
  return {
    root,
    stateParent,
    stateFilePath,
    tasks,
    patches,
    patchTaskId: submitted.taskId,
    tempParent,
    service,
    proposalBefore: patches.validationProposal(submitted.taskId),
    taskBefore: tasks.taskView(submitted.taskId),
    retainedStateBefore: readFileSync(stateFilePath, "utf8")
  };
}

type RealValidationHarness = Awaited<
  ReturnType<typeof makeRealValidationHarness>
>;

function assertRealValidationPreserved(
  harness: RealValidationHarness
): void {
  assert.equal(readFileSync(join(harness.root, "note.txt"), "utf8"), "before\n");
  assert.equal(existsSync(join(harness.root, "validation-artifact.txt")), false);
  assert.equal(git(harness.root, "status", "--short"), "");
  assert.deepEqual(
    harness.patches.validationProposal(harness.patchTaskId),
    harness.proposalBefore
  );
  assert.deepEqual(harness.tasks.taskView(harness.patchTaskId), harness.taskBefore);
  assert.equal(
    readFileSync(harness.stateFilePath, "utf8"),
    harness.retainedStateBefore
  );
  assert.equal(harness.tempParent.created.length, 1);
  assert.equal(existsSync(harness.tempParent.created[0]!), false);
  const worktrees = git(harness.root, "worktree", "list", "--porcelain");
  assert.equal(worktrees.match(/^worktree /gm)?.length ?? 0, 1);
}

function cleanupRealValidationHarness(harness: RealValidationHarness): void {
  for (const temporaryParent of harness.tempParent.created) {
    rmSync(temporaryParent, { recursive: true, force: true });
  }
  rmSync(harness.stateParent, { recursive: true, force: true });
  rmSync(harness.root, { recursive: true, force: true });
}

test("validate is INCOMPLETE with validation_profile_missing when no profile exists, without starting processes or temp state", async () => {
  const harness = makeHarness({ proposal: COMMIT_PROPOSAL, profile: undefined });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.reason, "validation_profile_missing");
  assert.equal(report.cleanup, "success");
  assert.equal(harness.patches.preflightCalls, 0);
  assert.equal(harness.runner.invocations.length, 0);
  assert.equal(harness.tempParent.created.length, 0);
});

test("validate is INCOMPLETE with unsupported_unborn_base for a retained unborn proposal before preflight, worktree, or processes", async () => {
  const harness = makeHarness({ proposal: UNBORN_PROPOSAL, profile: PROFILE });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.reason, "unsupported_unborn_base");
  assert.equal(report.cleanup, "success");
  assert.equal(harness.patches.preflightCalls, 0);
  assert.equal(harness.runner.invocations.length, 0);
  assert.equal(harness.tempParent.created.length, 0);
});

test("validate is INCOMPLETE with preflight_failed when the shared preflight fails, without starting worktree or processes", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    preflightError: new CoreError("WORKSPACE_PRECONDITION_FAILED")
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.reason, "preflight_failed");
  assert.equal(report.cleanup, "success");
  assert.equal(harness.patches.preflightCalls, 1);
  assert.equal(harness.runner.invocations.length, 0);
  assert.equal(harness.tempParent.created.length, 0);
});

for (const [name, outcome] of [
  [
    "nonzero exit",
    {
      kind: "exit",
      exitCode: 2,
      durationMs: 1,
      outputTail: "worktree add failed"
    }
  ],
  [
    "timeout",
    { kind: "timeout", durationMs: 1, outputTail: "" }
  ],
  [
    "spawn error",
    { kind: "spawn_error", durationMs: 1, outputTail: "" }
  ],
  [
    "signal",
    { kind: "signal", durationMs: 1, outputTail: "" }
  ]
] as const satisfies ReadonlyArray<
  readonly [string, ValidationProcessOutcome]
>) {
  test(`worktree creation ${name} starts no configured preparation or validation command`, async () => {
    const harness = makeHarness({
      proposal: COMMIT_PROPOSAL,
      profile: PROFILE
    });
    harness.runner.prefixOverrides.push({
      prefix: "git -C /workspaces/workspace-a worktree add --detach",
      outcome
    });

    const report = await harness.service.validate("task-1");

    assert.equal(report.status, "INCOMPLETE");
    assert.equal(
      harness.runner.invocations.some(({ argv }) => argv[0] === "npm"),
      false
    );
  });
}

for (const [name, outcome] of [
  [
    "nonzero exit",
    {
      kind: "exit",
      exitCode: 1,
      durationMs: 1,
      outputTail: "patch does not apply"
    }
  ],
  [
    "timeout",
    { kind: "timeout", durationMs: 1, outputTail: "" }
  ],
  [
    "spawn error",
    { kind: "spawn_error", durationMs: 1, outputTail: "" }
  ],
  [
    "signal",
    { kind: "signal", durationMs: 1, outputTail: "" }
  ]
] as const satisfies ReadonlyArray<
  readonly [string, ValidationProcessOutcome]
>) {
  test(`candidate apply ${name} starts no configured preparation or validation command`, async () => {
    const harness = makeHarness({
      proposal: COMMIT_PROPOSAL,
      profile: PROFILE,
      runnerOverrides: new Map([
        ["git apply --recount --unidiff-zero", outcome]
      ])
    });

    const report = await harness.service.validate("task-1");

    assert.equal(report.status, "INCOMPLETE");
    assert.equal(
      harness.runner.invocations.some(({ argv }) => argv[0] === "npm"),
      false
    );
  });
}

test("validate is FAIL when a preparation step exits nonzero and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm ci --ignore-scripts", {
        kind: "exit",
        exitCode: 7,
        durationMs: 5,
        outputTail: "install failed"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "FAIL");
  assert.equal(report.cleanup, "success");
  assert.equal(report.steps.length, 1);
  const failingStep = report.steps[0];
  assert.equal(failingStep?.name, "install");
  assert.equal(failingStep?.status, "FAIL");
  assert.equal(failingStep?.exit_code, 7);
  assert.equal(failingStep?.output_tail, "install failed");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(!started.includes("npm run build"));
  assert.ok(!started.includes("npm test"));
});

test("validate is FAIL when a validation step exits nonzero and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "exit",
        exitCode: 3,
        durationMs: 4,
        outputTail: "1 test failed"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "FAIL");
  assert.equal(report.cleanup, "success");
  assert.equal(report.steps.length, 3);
  const installStep = report.steps[0];
  assert.equal(installStep?.name, "install");
  assert.equal(installStep?.status, "PASS");
  const buildStep = report.steps[1];
  assert.equal(buildStep?.name, "build");
  assert.equal(buildStep?.status, "PASS");
  const failingStep = report.steps[2];
  assert.equal(failingStep?.name, "test");
  assert.equal(failingStep?.status, "FAIL");
  assert.equal(failingStep?.exit_code, 3);
  assert.equal(failingStep?.output_tail, "1 test failed");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE when a configured step times out and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "timeout",
        durationMs: 90_000,
        outputTail: "test timed out"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  const timedOutStep = report.steps.find((step) => step.name === "test");
  assert.equal(timedOutStep?.status, "INCOMPLETE");
  assert.equal(timedOutStep?.duration_ms, 90_000);
  assert.equal(timedOutStep?.output_tail, "test timed out");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE when a configured step fails to spawn and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm run build", {
        kind: "spawn_error",
        durationMs: 1,
        outputTail: ""
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  const failedToSpawnStep = report.steps.find((step) => step.name === "build");
  assert.equal(failedToSpawnStep?.status, "INCOMPLETE");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(!started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE when a configured step is terminated by a signal and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "signal",
        durationMs: 4,
        outputTail: "terminated by SIGKILL"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  const signaledStep = report.steps.find((step) => step.name === "test");
  assert.equal(signaledStep?.status, "INCOMPLETE");
  assert.equal(signaledStep?.output_tail, "terminated by SIGKILL");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE with failed cleanup when cleanup fails after all steps pass, preserving step evidence", async () => {
  const harness = makeHarness({ proposal: COMMIT_PROPOSAL, profile: PROFILE });
  harness.runner.prefixOverrides.push({
    prefix: "git -C /workspaces/workspace-a worktree remove --force",
    outcome: {
      kind: "exit",
      exitCode: 1,
      durationMs: 2,
      outputTail: "worktree not found"
    }
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "failed");
  assert.equal(report.steps.length, 4);
  assert.deepEqual(
    report.steps.map((step) => [step.name, step.status]),
    [
      ["install", "PASS"],
      ["build", "PASS"],
      ["test", "PASS"],
      ["lint", "PASS"]
    ]
  );
});

test("validate is INCOMPLETE with failed cleanup when cleanup fails after a step fails, preserving the failing step evidence", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "exit",
        exitCode: 3,
        durationMs: 4,
        outputTail: "1 test failed"
      }]
    ])
  });
  harness.runner.prefixOverrides.push({
    prefix: "git -C /workspaces/workspace-a worktree remove --force",
    outcome: {
      kind: "exit",
      exitCode: 1,
      durationMs: 2,
      outputTail: "worktree not found"
    }
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "failed");
  const failingStep = report.steps.find((step) => step.name === "test");
  assert.equal(failingStep?.status, "FAIL");
  assert.equal(failingStep?.exit_code, 3);
  assert.equal(failingStep?.output_tail, "1 test failed");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate gives the whole cleanup sequence one deadline when parent removal hangs", async () => {
  const cleanupDeadlineTimer = new ManualCleanupDeadlineTimer();
  let removeParentStarted = false;
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: {
      ...PROFILE,
      preparation: [],
      validation: []
    },
    removeParent: () => {
      removeParentStarted = true;
      return new Promise<void>(() => {});
    },
    cleanupDeadlineTimer
  });
  let finishWorktreeRemoval:
    | ((outcome: ValidationProcessOutcome) => void)
    | undefined;
  const worktreeRemoval = new Promise<ValidationProcessOutcome>((resolve) => {
    finishWorktreeRemoval = resolve;
  });
  harness.runner.prefixOverrides.push({
    prefix: "git -C /workspaces/workspace-a worktree remove --force",
    outcome: worktreeRemoval
  });

  const validation = harness.service.validate("task-1");
  const cleanupStarted = () => harness.runner.invocations.some(({ argv }) =>
    argv.slice(0, 6).join(" ") ===
      "git -C /workspaces/workspace-a worktree remove --force"
  );
  for (let turn = 0; turn < 20 && !cleanupStarted(); turn++) {
    await Promise.resolve();
  }

  assert.equal(cleanupStarted(), true);
  assert.equal(cleanupDeadlineTimer.pendingCount, 1);
  assert.notEqual(finishWorktreeRemoval, undefined);
  finishWorktreeRemoval!(DEFAULT_OUTCOME);

  for (let turn = 0; turn < 20 && !removeParentStarted; turn++) {
    await Promise.resolve();
  }

  assert.equal(removeParentStarted, true);
  assert.equal(cleanupDeadlineTimer.setCount, 1);
  assert.equal(cleanupDeadlineTimer.fire(), 5_000);

  const report = await validation;
  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "failed");
  assert.equal(report.reason, "cleanup_failed");
});

test("validate never starts parent removal after the cleanup deadline expires during worktree removal", async () => {
  const cleanupDeadlineTimer = new ManualCleanupDeadlineTimer();
  let removeParentCalls = 0;
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: {
      ...PROFILE,
      preparation: [],
      validation: []
    },
    removeParent: async () => {
      removeParentCalls++;
    },
    cleanupDeadlineTimer
  });
  let finishWorktreeRemoval:
    | ((outcome: ValidationProcessOutcome) => void)
    | undefined;
  const worktreeRemoval = new Promise<ValidationProcessOutcome>((resolve) => {
    finishWorktreeRemoval = resolve;
  });
  harness.runner.prefixOverrides.push({
    prefix: "git -C /workspaces/workspace-a worktree remove --force",
    outcome: worktreeRemoval
  });

  const validation = harness.service.validate("task-1");
  const cleanupStarted = () => harness.runner.invocations.some(({ argv }) =>
    argv.slice(0, 6).join(" ") ===
      "git -C /workspaces/workspace-a worktree remove --force"
  );
  for (let turn = 0; turn < 20 && !cleanupStarted(); turn++) {
    await Promise.resolve();
  }

  assert.equal(cleanupStarted(), true);
  assert.equal(cleanupDeadlineTimer.pendingCount, 1);
  assert.equal(cleanupDeadlineTimer.setCount, 1);
  assert.notEqual(finishWorktreeRemoval, undefined);
  assert.equal(cleanupDeadlineTimer.fire(), 5_000);

  const report = await validation;
  assert.equal(report.cleanup, "failed");

  finishWorktreeRemoval!(DEFAULT_OUTCOME);
  for (let turn = 0; turn < 20; turn++) {
    await Promise.resolve();
  }
  assert.equal(removeParentCalls, 0);
});

test("validate is PASS when preparation, validation, and cleanup all succeed", async () => {
  const harness = makeHarness({ proposal: COMMIT_PROPOSAL, profile: PROFILE });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "PASS");
  assert.equal(report.cleanup, "success");
  assert.deepEqual(
    report.steps.map((step) => [step.name, step.status]),
    [
      ["install", "PASS"],
      ["build", "PASS"],
      ["test", "PASS"],
      ["lint", "PASS"]
    ]
  );
});

test("validate caps each configured step timeout at min(step timeout, remaining total budget) under a deterministic clock", async () => {
  let nowMsCalls = 0;
  const nowMs = () => (nowMsCalls++ === 0 ? 0 : 700_000);
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    nowMs
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "PASS");
  // Remaining total budget under the deterministic clock:
  // 1200s total - 700s elapsed = 500s = 500_000ms.
  const byArgv = new Map(
    harness.runner.invocations.map((invocation) => [
      invocation.argv.join(" "),
      invocation
    ])
  );
  assert.equal(byArgv.get("npm ci --ignore-scripts")?.timeoutMs, 500_000);
  assert.equal(byArgv.get("npm run build")?.timeoutMs, 500_000);
  assert.equal(byArgv.get("npm test")?.timeoutMs, 90_000);
  assert.equal(byArgv.get("npm run lint")?.timeoutMs, 500_000);
});

test("real Git validation uses a detached temporary worktree, isolates candidate changes and artifacts, and cleans up after PASS", async (t) => {
  const inspectAndCreateArtifact = [
    "const fs=require('node:fs');",
    "const cp=require('node:child_process');",
    "const detached=cp.spawnSync('git',['symbolic-ref','-q','HEAD'],",
    "{stdio:'ignore'}).status===1;",
    "if(!detached||fs.readFileSync('note.txt','utf8')!=='after\\n')",
    "process.exit(1);",
    "fs.writeFileSync('validation-artifact.txt','ok\\n');"
  ].join("");
  const harness = await makeRealValidationHarness(realProfile([
    {
      name: "inspect-isolation",
      argv: [process.execPath, "-e", inspectAndCreateArtifact]
    }
  ]));
  t.after(() => cleanupRealValidationHarness(harness));

  const report = await harness.service.validate(harness.patchTaskId);

  assert.equal(report.status, "PASS");
  assert.equal(report.cleanup, "success");
  assert.deepEqual(
    report.steps.map(({ name, status }) => [name, status]),
    [["inspect-isolation", "PASS"]]
  );
  assertRealValidationPreserved(harness);
});

test("real Git validation removes the temporary worktree after FAIL without changing the retained proposal or registered workspace", async (t) => {
  const harness = await makeRealValidationHarness(realProfile([
    {
      name: "fail",
      argv: [process.execPath, "-e", "process.exit(7)"]
    }
  ]));
  t.after(() => cleanupRealValidationHarness(harness));

  const report = await harness.service.validate(harness.patchTaskId);

  assert.equal(report.status, "FAIL");
  assert.equal(report.cleanup, "success");
  assert.equal(report.steps[0]?.status, "FAIL");
  assert.equal(report.steps[0]?.exit_code, 7);
  assertRealValidationPreserved(harness);
});

test("real Git validation removes the temporary worktree after timeout/INCOMPLETE without changing the retained proposal or registered workspace", async (t) => {
  const timeoutCommand: readonly [string, ...string[]] = [
    process.execPath,
    "-e",
    "void 0"
  ];
  const runner = new FakeValidationProcessRunner(
    new ValidationProcessRunner()
  );
  runner.overrides.set(timeoutCommand.join(" "), {
    kind: "timeout",
    durationMs: 30_000,
    outputTail: "validation timed out"
  });
  const harness = await makeRealValidationHarness(
    realProfile([
      {
        name: "timeout",
        argv: timeoutCommand,
        timeoutSeconds: 30
      }
    ]),
    runner
  );
  t.after(() => cleanupRealValidationHarness(harness));

  const report = await harness.service.validate(harness.patchTaskId);

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  assert.equal(report.steps[0]?.status, "INCOMPLETE");
  assert.equal(report.steps[0]?.duration_ms, 30_000);
  assert.equal(report.steps[0]?.output_tail, "validation timed out");
  assertRealValidationPreserved(harness);
});
