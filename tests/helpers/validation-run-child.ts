// Disposable IPC fixture for service-owner death, never a production entry point.
import fs from "node:fs/promises";
import { join } from "node:path";
import { ControlledPatchValidationRunService } from "../../src/tasks/controlled-patch-validation-run-service.js";
import { ControlledPatchService } from "../../src/tasks/controlled-patch-service.js";
import { ValidationProfileStore } from "../../src/tasks/validation-profile-store.js";
import { RegisteredWorkspaceRegistry } from "../../src/workspaces/registered-workspace-registry.js";
import { RegisteredWorkspaceTaskService } from "../../src/tasks/registered-workspace-task-service.js";

const parent = process.argv[2]!;
const workspace = join(parent, "project");
const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root: workspace, allow_write: true }]);
const tasks = new RegisteredWorkspaceTaskService(registry, () => { throw Error("no executor in lifecycle fixture"); });
const patches = new ControlledPatchService(registry, tasks, undefined, join(parent, "proposals.json"));
await patches.load();
const service = await ControlledPatchValidationRunService.open({ registry, controlledPatches: patches,
  profiles: new ValidationProfileStore(join(parent, "profiles.json")), directory: join(parent, "runs"),
  tempRoot: join(parent, "validation-temp"), protectedRoots: [workspace] });
process.on("SIGTERM", () => { void service.shutdown("bridge_sigterm").then(() => process.exit(0), () => process.exit(1)); });
const run = await service.start({ patch_task_id: process.argv[3]!, idempotency_key: "child-start" });
process.send?.({ validation_run_id: run.validation_run_id });
