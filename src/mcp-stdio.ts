#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CodexExecutor } from "./executors/codex-executor.js";
import { DshExecutor } from "./executors/dsh-executor.js";
import { VERSION } from "./version.js";
import { CoreError, serializeError } from "./core/errors.js";
import { CODEX_ROUTING_POLICY_ENV, parseCodexRoutingPolicy } from "./core/codex-routing-policy.js";
import { RegisteredWorkspaceTaskService } from "./tasks/registered-workspace-task-service.js";
import { ControlledPatchService } from "./tasks/controlled-patch-service.js";
import { ControlledPatchValidationService } from "./tasks/controlled-patch-validation-service.js";
import {
  type ValidationProfile,
  type ValidationStep,
  ValidationProfileStore
} from "./tasks/validation-profile-store.js";
import { ValidationProcessRunner } from "./tasks/validation-process-runner.js";
import { ManagedWorkspaceCatalog } from "./workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "./workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "./workspaces/workspace-onboarding-service.js";

const WorkspaceEntrySchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  allow_write: z.boolean().optional()
}).strict();

const ProjectRootEntrySchema = z.object({
  kind: z.literal("project_root"),
  root: z.string().min(1)
}).strict();

const WorkspaceConfigSchema = z.array(z.union([WorkspaceEntrySchema, ProjectRootEntrySchema]));

const ValidationStepSchema = z.object({
  name: z.string().min(1),
  argv: z.array(z.string()).min(1),
  timeout_seconds: z.number().int().positive().optional()
}).strict();

const ValidationProfileSchema = z.object({
  preparation: z.array(ValidationStepSchema),
  validation: z.array(ValidationStepSchema),
  default_step_timeout_seconds: z.number().int().positive().optional().default(600),
  total_timeout_seconds: z.number().int().positive().optional().default(1200)
}).strict();

type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
type ProjectRootEntry = z.infer<typeof ProjectRootEntrySchema>;

function isProjectRootEntry(entry: WorkspaceEntry | ProjectRootEntry): entry is ProjectRootEntry {
  return "kind" in entry;
}

function toValidationStep(
  step: z.infer<typeof ValidationStepSchema>
): ValidationStep {
  return {
    name: step.name,
    argv: [step.argv[0]!, ...step.argv.slice(1)],
    ...(step.timeout_seconds === undefined
      ? {}
      : { timeoutSeconds: step.timeout_seconds })
  };
}

function toValidationProfile(
  profile: z.infer<typeof ValidationProfileSchema>
): ValidationProfile {
  return {
    preparation: profile.preparation.map(toValidationStep),
    validation: profile.validation.map(toValidationStep),
    defaultStepTimeoutSeconds: profile.default_step_timeout_seconds,
    totalTimeoutSeconds: profile.total_timeout_seconds
  };
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function unknownTask() {
  return {
    isError: true,
    ...jsonContent({ error: "UNKNOWN_TASK" })
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json");
  }

  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("Workspace configuration path is required.");
  const codexRoutingPolicy = parseCodexRoutingPolicy(process.env[CODEX_ROUTING_POLICY_ENV]);
  const configSource = await readFile(configPath, "utf8");
  const parsed = WorkspaceConfigSchema.parse(JSON.parse(configSource.startsWith("\uFEFF") ? configSource.slice(1) : configSource));
  const workspaceEntries = parsed.filter((entry): entry is WorkspaceEntry => !isProjectRootEntry(entry));
  const projectRootEntries = parsed.filter(isProjectRootEntry);
  const registry = new RegisteredWorkspaceRegistry(workspaceEntries);
  const catalog = new ManagedWorkspaceCatalog(`${configPath}.managed-workspaces.json`);
  await catalog.load();
  for (const entry of catalog.entries()) {
    try {
      registry.registerManaged(entry.id, entry.root, entry.allowWrite);
    } catch {
      // A manual or earlier managed registration already owns the id or root.
    }
  }
  const onboarding = new WorkspaceOnboardingService(
    registry,
    catalog,
    projectRootEntries.map(({ root }) => root)
  );
  const service = new RegisteredWorkspaceTaskService(
    registry,
    (executor, workspaceRoot) => {
      switch (executor) {
        case "codex": return new CodexExecutor(workspaceRoot, undefined, undefined, undefined, undefined, codexRoutingPolicy);
        case "dsh": return new DshExecutor(workspaceRoot);
      }
    }
  );
  const controlledPatches = new ControlledPatchService(
    registry,
    service,
    undefined,
    `${configPath}.controlled-patches.json`
  );
  await controlledPatches.load();
  const validationProfiles = new ValidationProfileStore(
    `${configPath}.validation-profiles.json`
  );
  const validationRunner = new ValidationProcessRunner();
  const validation = new ControlledPatchValidationService(
    registry,
    controlledPatches,
    validationProfiles,
    validationRunner
  );
  const server = new McpServer({ name: "engineering-bridge", version: VERSION });

  server.registerTool("run_task", {
    description: "Run a read-only task with the selected executor in a pre-registered workspace. This tool does not modify workspace files.",
    inputSchema: {
      workspace_id: z.string().min(1),
      instruction: z.string().min(1),
      executor: z.enum(["codex", "dsh"]).optional().default("codex"),
      model: z.string().min(1).optional(),
      reasoning_effort: z.string().min(1).optional()
    }
  }, ({ workspace_id, instruction, executor, model, reasoning_effort }) => {
    try {
      if (executor === "dsh" && (model !== undefined || reasoning_effort !== undefined)) {
        throw new CoreError("UNSUPPORTED_ACTION");
      }
      const { taskId } = service.startTask({ workspace_id, instruction, executor,
        ...(model === undefined ? {} : { model }),
        ...(reasoning_effort === undefined ? {} : { reasoning_effort }) });
      return jsonContent({ task_id: taskId });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("task_result", {
    description: "Retrieve the completed output or safe error for a task. This tool is read-only.",
    inputSchema: { task_id: z.string() }
  }, ({ task_id }) => {
    const view = service.taskView(task_id);
    if (view === undefined) return unknownTask();
    const taskView = { task_id: view.taskId, state: view.state,
      ...(view.source === undefined ? {} : { source: view.source }),
      ...(view.executor === undefined ? {} : { executor: view.executor }),
      ...(view.threadId === undefined ? {} : { thread_id: view.threadId }),
      ready: view.ready,
      ...(view.output === undefined ? {} : { output: view.output }),
      ...(view.review_output === undefined ? {} : { review_output: view.review_output }),
      ...(view.partial_output === undefined ? {} : { partial_output: view.partial_output }),
      evidence: view.evidence,
      ...(view.diagnostics === undefined ? {} : { diagnostics: view.diagnostics }),
      ...(view.error === undefined ? {} : { error: view.error }) };
    return jsonContent({
      ...taskView,
      mcp_diagnostics: {
        serialized_task_view_bytes: Buffer.byteLength(JSON.stringify(taskView), "utf8")
      }
    });
  });

  server.registerTool("control_task", {
    description: "Steer or interrupt a running task, continue a reviewed task, or accept reviewed output.",
    inputSchema: {
      task_id: z.string(),
      action: z.enum(["continue", "steer", "interrupt", "accept"]),
      instruction: z.string().optional()
    }
  }, async ({ task_id, action, instruction }) => {
    if (service.taskView(task_id) === undefined) return unknownTask();
    try {
      const view = await service.controlTask(task_id, action, instruction);
      return jsonContent({ task_id: view.taskId, state: view.state });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("bind_project", {
    description: "Register an existing local project directory as a read-only workspace. The path must already exist inside a configured project_root and the call requires exact BIND confirmation.",
    inputSchema: {
      project_path: z.string().min(1),
      confirmation: z.literal("BIND")
    }
  }, async ({ project_path }) => {
    try {
      return jsonContent(await onboarding.bind({ project_path }));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("create_project", {
    description: "Create a new empty Git project directory inside a configured project_root and register it as a read-only workspace. The call requires exact CREATE confirmation; only mkdir and git init are performed.",
    inputSchema: {
      parent: z.string().min(1),
      name: z.string().min(1),
      confirmation: z.literal("CREATE")
    }
  }, async ({ parent, name }) => {
    try {
      return jsonContent(await onboarding.create({ parent, name }));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("authorize_workspace_write", {
    description: "Grant persistent controlled-write authorization to a managed workspace after exact AUTHORIZE confirmation. Manual workspaces remain authoritative through workspaces.json. Ordinary run_task calls stay read-only.",
    inputSchema: {
      workspace_id: z.string().min(1),
      confirmation: z.literal("AUTHORIZE")
    }
  }, async ({ workspace_id }) => {
    try {
      return jsonContent(await onboarding.authorizeWrite(workspace_id));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("generate_controlled_patch", {
    description: "Generate a read-only patch proposal for review in any registered Git workspace; generation requires no write authorization, and controlled-write authorization is required only to APPLY.",
    inputSchema: {
      workspace_id: z.string().min(1),
      change_request: z.string().min(1),
      executor: z.enum(["codex", "dsh"]).optional().default("codex"),
      model: z.string().min(1).optional(),
      reasoning_effort: z.string().min(1).optional()
    }
  }, async ({ workspace_id, change_request, executor, model, reasoning_effort }) => {
    try {
      if (executor === "dsh" && (model !== undefined || reasoning_effort !== undefined)) {
        throw new CoreError("UNSUPPORTED_ACTION");
      }
      const proposal = await controlledPatches.generate({ workspace_id, change_request, executor,
        ...(model === undefined ? {} : { model }),
        ...(reasoning_effort === undefined ? {} : { reasoning_effort }) });
      return jsonContent({ task_id: proposal.taskId, base_head: proposal.baseHead });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("refine_controlled_patch", {
    description: "Refine a completed retained patch proposal into a new complete read-only proposal against the same base HEAD.",
    inputSchema: {
      patch_task_id: z.string().min(1),
      change_request: z.string().min(1),
      executor: z.enum(["codex", "dsh"]).optional().default("codex"),
      model: z.string().min(1).optional(),
      reasoning_effort: z.string().min(1).optional()
    }
  }, async ({ patch_task_id, change_request, executor, model, reasoning_effort }) => {
    try {
      if (executor === "dsh" && (model !== undefined || reasoning_effort !== undefined)) {
        throw new CoreError("UNSUPPORTED_ACTION");
      }
      const proposal = await controlledPatches.refine({ patch_task_id, change_request, executor,
        ...(model === undefined ? {} : { model }),
        ...(reasoning_effort === undefined ? {} : { reasoning_effort }) });
      return jsonContent({ task_id: proposal.taskId, base_head: proposal.baseHead });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("submit_controlled_patch", {
    description: "Submit a caller-provided complete unified Git diff as a read-only patch proposal against exactly the current commit HEAD. Nothing is written until the returned task is applied with exact APPLY; the proposal carries source: \"submitted\" and no executor identity.",
    inputSchema: {
      workspace_id: z.string().min(1),
      base_head: z.string().min(1),
      diff: z.string().min(1)
    }
  }, async ({ workspace_id, base_head, diff }) => {
    try {
      const proposal = await controlledPatches.submit({ workspace_id, base_head, diff });
      return jsonContent({ task_id: proposal.taskId, base_head: proposal.baseHead });
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("apply_controlled_patch", {
    description: "Apply one reviewed patch proposal after exact APPLY confirmation. This tool can modify validated tracked text files or add absent 100644 text files, but never stages, commits, or pushes.",
    inputSchema: {
      patch_task_id: z.string().min(1),
      confirmation: z.literal("APPLY")
    }
  }, async ({ patch_task_id, confirmation }) => jsonContent(
    await controlledPatches.apply({ patch_task_id, confirmation })
  ));

  server.registerTool("commit_controlled_patch", {
    description: "Create one Git commit containing only an already-APPLYed controlled patch after exact COMMIT confirmation. Never pushes.",
    inputSchema: {
      patch_task_id: z.string().min(1),
      message: z.string().min(1),
      confirmation: z.literal("COMMIT")
    }
  }, async ({ patch_task_id, message, confirmation }) => jsonContent(
    await controlledPatches.commit({
      patch_task_id,
      message,
      confirmation
    })
  ));

  server.registerTool("configure_validation_profile", {
    description: "Configure the fixed validation profile for a registered workspace after exact CONFIGURE confirmation.",
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      profile: ValidationProfileSchema,
      confirmation: z.literal("CONFIGURE")
    }).strict()
  }, async ({ workspace_id, profile }) => {
    try {
      return jsonContent(await validation.configure(
        workspace_id,
        toValidationProfile(profile)
      ));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  server.registerTool("validate_controlled_patch", {
    description: "Validate one retained controlled patch with its workspace's configured profile.",
    inputSchema: z.object({
      patch_task_id: z.string().min(1)
    }).strict()
  }, async ({ patch_task_id }) => {
    try {
      return jsonContent(await validation.validate(patch_task_id));
    } catch (error) {
      return { isError: true, ...jsonContent({ error: serializeError(error) }) };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Failed to start engineering-bridge.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
