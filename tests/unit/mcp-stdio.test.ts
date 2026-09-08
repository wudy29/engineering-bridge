import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isolateGitLineEndings } from "../helpers/git-fixture.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VERSION_MODULE = new URL("../../src/version.js", import.meta.url);

interface ToolResult {
  content: Array<{ type?: string; text?: string } | undefined>;
}

test("workspace configuration strips exactly one leading UTF-8 BOM", async () => {
  const cases = [
    { source: "\uFEFF[]\n", accepted: true },
    { source: "\uFEFF\uFEFF[]\n", accepted: false }
  ] as const;

  for (const { source, accepted } of cases) {
    const configRoot = mkdtempSync(join(tmpdir(), "engineering-bridge-bom-"));
    const configPath = join(configRoot, "workspaces.json");
    writeFileSync(configPath, source);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    try {
      if (!accepted) {
        await assert.rejects(client.connect(transport));
        continue;
      }
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(listed.tools.some(({ name }) => name === "run_task"), true);
    } finally {
      try {
        await client.close();
      } finally {
        rmSync(configRoot, { recursive: true, force: true });
      }
    }
  }
});

test("startup fails closed for an invalid Codex routing policy", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "engineering-bridge-routing-policy-startup-"));
  const configPath = join(configRoot, "workspaces.json");
  writeFileSync(configPath, "[]\n");
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    env: { ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY: "STRICT" },
    stderr: "pipe"
  });

  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("explicit Codex routing from the environment reaches run_task before Codex spawn", async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "engineering-bridge-routing-policy-mcp-"));
  const workspaceRoot = join(configRoot, "workspace");
  mkdirSync(workspaceRoot);
  const markerPath = join(configRoot, "codex-started");
  const codexPath = join(configRoot, "codex");
  writeFileSync(codexPath, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");\n`);
  chmodSync(codexPath, 0o755);
  const configPath = join(configRoot, "workspaces.json");
  writeFileSync(configPath, `${JSON.stringify([{ id: "workspace", root: workspaceRoot }])}\n`);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    env: {
      PATH: configRoot,
      ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY: "explicit"
    },
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type?: string; text?: string }>;
    return JSON.parse(content[0]?.text ?? "{}");
  };

  try {
    await client.connect(transport);
    const started = await call("run_task", {
      workspace_id: "workspace",
      instruction: "inspect"
    });
    const taskId = started.task_id;
    assert.equal(typeof taskId, "string");
    let terminal: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      terminal = await call("task_result", { task_id: taskId });
      if (terminal.state !== "queued" && terminal.state !== "running") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(terminal.error, {
      code: "CODEX_ROUTING_REQUIRED",
      message: "Explicit model and reasoning_effort are required for Codex execution."
    });
    assert.equal(existsSync(markerPath), false);
  } finally {
    await client.close();
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("MCP and Codex client metadata use the shared package VERSION, and stdio returns structured tool errors", async () => {
  const { VERSION } = await import(VERSION_MODULE.href) as { VERSION: unknown };
  const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: unknown }).version;

  assert.equal(VERSION, packageVersion);
  for (const path of ["src/mcp-stdio.ts", "src/executors/codex-executor.ts"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /import\s+\{\s*VERSION\s*\}\s+from\s+["'][^"']*version\.js["'];/u);
    assert.match(source, /version:\s*VERSION\b/u);
  }

  const configPath = join(mkdtempSync(join(tmpdir(), "engineering-bridge-mcp-")), "workspaces.json");
  writeFileSync(configPath, "[]\n");
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, VERSION);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name).sort(), [
      "apply_controlled_patch",
      "authorize_workspace_write",
      "bind_project",
      "commit_controlled_patch",
      "configure_validation_profile",
      "control_task",
      "create_project",
      "generate_controlled_patch",
      "refine_controlled_patch",
      "run_task",
      "submit_controlled_patch",
      "task_result",
      "validate_controlled_patch"
    ]);

    const schemas = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema as {
      properties?: Record<string, { type?: string; minLength?: number; const?: unknown }>;
      required?: string[];
    }]));
    for (const name of ["run_task", "generate_controlled_patch", "refine_controlled_patch"]) {
      const properties = schemas.get(name)?.properties;
      assert.equal(properties?.model?.type, "string");
      assert.equal(properties?.model?.minLength, 1);
      assert.equal(properties?.reasoning_effort?.type, "string");
      assert.equal(properties?.reasoning_effort?.minLength, 1);
    }

    // COMMIT requires every field and the exact literal confirmation.
    const commitSchema = schemas.get("commit_controlled_patch");
    assert.equal(commitSchema?.properties?.confirmation?.const, "COMMIT");
    for (const field of ["patch_task_id", "message", "confirmation"]) {
      assert.equal(commitSchema?.required?.includes(field), true);
    }

    for (const [name, argumentsValue] of [
      ["run_task", { workspace_id: "missing", instruction: "inspect", executor: "dsh", model: "gpt-5-codex" }],
      ["generate_controlled_patch", { workspace_id: "missing", change_request: "change", executor: "dsh", reasoning_effort: "high" }],
      ["refine_controlled_patch", { patch_task_id: "missing", change_request: "refine", executor: "dsh", model: "gpt-5-codex" }]
    ] as const) {
      const rejected = await client.callTool({ name, arguments: argumentsValue });
      assert.equal(rejected.isError, true);
      const rejectedContent = rejected.content;
      assert.ok(Array.isArray(rejectedContent));
      if (!Array.isArray(rejectedContent)) continue;
      const rejectedItem = rejectedContent[0];
      assert.equal(rejectedItem?.type, "text");
      if (rejectedItem?.type !== "text") continue;
      assert.equal(JSON.parse(rejectedItem.text).error.code, "UNSUPPORTED_ACTION");
      assert.equal(JSON.stringify(rejected).includes("UNKNOWN_WORKSPACE"), false);
      assert.equal(JSON.stringify(rejected).includes("INVALID_STATE_TRANSITION"), false);
    }

    const result = await client.callTool({
      name: "generate_controlled_patch",
      arguments: { workspace_id: "missing", change_request: "change nothing" }
    });
    assert.equal(result.isError, true);
    const resultContent = result.content;
    assert.ok(Array.isArray(resultContent));
    const content = resultContent[0] as { type?: string; text?: string } | undefined;
    assert.equal(content?.type, "text");
    if (content?.type !== "text" || typeof content.text !== "string") return;
    assert.deepEqual(JSON.parse(content.text), {
      error: {
        code: "UNKNOWN_WORKSPACE",
        message: "The requested workspace is not registered."
      }
    });

    const refinementResult = await client.callTool({
      name: "refine_controlled_patch",
      arguments: { patch_task_id: "missing", change_request: "refine nothing" }
    });
    assert.equal(refinementResult.isError, true);
    const refinementResultContent = refinementResult.content;
    assert.ok(Array.isArray(refinementResultContent));
    const refinementContent = refinementResultContent[0] as { type?: string; text?: string } | undefined;
    assert.equal(refinementContent?.type, "text");
    if (refinementContent?.type !== "text" || typeof refinementContent.text !== "string") return;
    assert.deepEqual(JSON.parse(refinementContent.text), {
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: "The requested state transition is not allowed."
      }
    });

    for (const argumentsValue of [
      { workspace_id: "missing", instruction: "inspect" },
      { workspace_id: "missing", instruction: "inspect", executor: "codex" },
      { workspace_id: "missing", instruction: "inspect", executor: "dsh" }
    ]) {
      const runResult = await client.callTool({
        name: "run_task",
        arguments: argumentsValue
      });
      assert.notEqual(runResult.isError, true);
      const runContent = runResult.content;
      assert.ok(Array.isArray(runContent));
      const first = runContent[0] as { type?: string; text?: string } | undefined;
      assert.equal(first?.type, "text");
      assert.equal(typeof first?.text, "string");
      if (typeof first?.text === "string") {
        const body = JSON.parse(first.text) as { task_id?: unknown };
        assert.equal(typeof body.task_id, "string");
      }
    }

    const unknownExecutor = await client.callTool({
      name: "run_task",
      arguments: {
        workspace_id: "missing",
        instruction: "inspect",
        executor: "unknown"
      }
    });
    assert.equal(unknownExecutor.isError, true);
    assert.equal(JSON.stringify(unknownExecutor).includes("task_id"), false);
  } finally {
    await client.close();
  }
});

test("task_result honestly reports the fixed executor and never fabricates a thread id", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-executor-view-"));
  const configPath = join(configDir, "workspaces.json");
  writeFileSync(configPath, "[]\n");

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body: body as Record<string, unknown> };
  };

  const waitForTerminal = async (taskId: string): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const poll = await call("task_result", { task_id: taskId });
      if (poll.body.state !== "queued" && poll.body.state !== "running") return poll.body;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("task did not reach a terminal state");
  };

  try {
    await client.connect(transport);

    // Default selection is codex; the JSON carries it and no thread_id exists.
    const codexRun = await call("run_task", {
      workspace_id: "missing",
      instruction: "inspect"
    });
    const codexTaskId = codexRun.body.task_id;
    assert.equal(typeof codexTaskId, "string");
    if (typeof codexTaskId !== "string") return;
    const codexView = await waitForTerminal(codexTaskId);
    assert.equal(codexView.executor, "codex");
    assert.equal("thread_id" in codexView, false);
    assert.deepEqual(codexView.error, {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    });

    // Explicit dsh selection is reported as dsh, still without any thread_id.
    const dshRun = await call("run_task", {
      workspace_id: "missing",
      instruction: "inspect",
      executor: "dsh"
    });
    const dshTaskId = dshRun.body.task_id;
    assert.equal(typeof dshTaskId, "string");
    if (typeof dshTaskId !== "string") return;
    const dshView = await waitForTerminal(dshTaskId);
    assert.equal(dshView.executor, "dsh");
    assert.equal("thread_id" in dshView, false);
    assert.deepEqual(dshView.error, {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    });
  } finally {
    await client.close();
  }
});

test("bind_project and create_project register workspaces inside approved project roots", async () => {
  const approved = mkdtempSync(join(tmpdir(), "engineering-bridge-approved-"));
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-onboard-"));
  const configPath = join(configDir, "workspaces.json");
  const manualProject = join(approved, "manual-project");
  mkdirSync(manualProject);
  const otherProject = join(approved, "other-project");
  mkdirSync(otherProject);
  writeFileSync(configPath, `${JSON.stringify([
    { kind: "project_root", root: approved },
    { id: "manual", root: manualProject, allow_write: true }
  ], null, 2)}\n`);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body };
  };

  try {
    await client.connect(transport);

    // Binding an existing manual workspace returns its real allow_write and source.
    const manualBind = await call("bind_project", {
      project_path: manualProject,
      confirmation: "BIND"
    });
    assert.equal(manualBind.isError, false);
    assert.deepEqual(manualBind.body, {
      workspace_id: "manual",
      root: manualProject,
      allow_write: true,
      source: "manual"
    });

    // Binding a new project creates a managed workspace and reuses its id.
    const firstBind = await call("bind_project", {
      project_path: otherProject,
      confirmation: "BIND"
    });
    assert.equal(firstBind.isError, false);
    const firstBody = firstBind.body as { workspace_id?: unknown; root?: unknown; allow_write?: unknown; source?: unknown };
    assert.equal(typeof firstBody.workspace_id, "string");
    assert.equal(firstBody.root, realpathSync(otherProject));
    assert.equal(firstBody.allow_write, false);
    assert.equal(firstBody.source, "managed");

    const secondBind = await call("bind_project", {
      project_path: otherProject,
      confirmation: "BIND"
    });
    assert.deepEqual(secondBind.body, firstBind.body);

    // The managed workspace is immediately usable for task routing.
    const run = await call("run_task", {
      workspace_id: firstBody.workspace_id,
      instruction: "inspect",
      executor: "dsh"
    });
    assert.equal(run.isError, false);
    assert.equal(typeof (run.body as { task_id?: unknown }).task_id, "string");

    // create_project performs mkdir + git init and reports an unborn HEAD.
    const created = await call("create_project", {
      parent: approved,
      name: "created-project",
      confirmation: "CREATE"
    });
    assert.equal(created.isError, false);
    const createdBody = created.body as { workspace_id?: unknown; root?: unknown; allow_write?: unknown; git?: unknown };
    assert.equal(typeof createdBody.workspace_id, "string");
    assert.equal(createdBody.root, realpathSync(join(approved, "created-project")));
    assert.equal(createdBody.allow_write, false);
    assert.deepEqual(createdBody.git, { initialized: true, head: "unborn" });
    isolateGitLineEndings(join(approved, "created-project"));
    assert.equal(readFileSync(join(approved, "created-project", ".git", "HEAD"), "utf8").includes("ref:"), true);

    // Wrong or missing confirmation is rejected by the schema without side effects.
    const wrongConfirmation = await call("create_project", {
      parent: approved,
      name: "rejected-project",
      confirmation: "NO"
    });
    assert.equal(wrongConfirmation.isError, true);
    assert.equal(JSON.stringify(wrongConfirmation.body).includes("workspace_id"), false);

    // Paths outside every approved root are rejected with a structured error.
    const outside = mkdtempSync(join(tmpdir(), "engineering-bridge-outside-"));
    const outsideBind = await call("bind_project", {
      project_path: outside,
      confirmation: "BIND"
    });
    assert.equal(outsideBind.isError, true);
    assert.deepEqual(outsideBind.body, {
      error: {
        code: "WORKSPACE_BOUNDARY_VIOLATION",
        message: "The workspace boundary could not be verified."
      }
    });
  } finally {
    await client.close();
  }
});

test("startup rejects invalid manual and project roots and accepts a valid project_root", async () => {
  const invalidRoots = ["relative/root", "/registered/../root"];
  if (process.platform === "win32") invalidRoots.push("\\root", "\\workspace\\child", "C:relative");
  const invalidEntries = invalidRoots.flatMap((root) => [{ kind: "project_root", root }, { id: "manual", root }]);
  for (const entry of invalidEntries) {
    const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-badroot-"));
    const configPath = join(configDir, "workspaces.json");
    writeFileSync(configPath, `${JSON.stringify([entry], null, 2)}\n`);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    // The server exits during startup, so connecting must fail.
    await assert.rejects(client.connect(transport));
    await client.close();
  }

  // A valid absolute, normalized project_root still boots.
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-goodroot-"));
  const configPath = join(configDir, "workspaces.json");
  writeFileSync(configPath, `${JSON.stringify([{ kind: "project_root", root: configDir }], null, 2)}\n`);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some(({ name }) => name === "bind_project"), true);
  } finally {
    await client.close();
  }
});

test("bind_project fails closed when no project_root is configured", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-noroots-"));
  const configPath = join(configDir, "workspaces.json");
  const project = join(configDir, "project");
  mkdirSync(project);
  writeFileSync(configPath, "[]\n");

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "bind_project",
      arguments: { project_path: project, confirmation: "BIND" }
    });
    assert.equal(result.isError, true);
    const content = result.content as ToolResult["content"];
    const body = JSON.parse(content[0]?.text ?? "") as { error?: unknown };
    assert.deepEqual(body.error, {
      code: "WORKSPACE_BOUNDARY_VIOLATION",
      message: "The workspace boundary could not be verified."
    });
  } finally {
    await client.close();
  }
});

test("authorize_workspace_write persists for managed workspaces and rejects manual ones", async () => {
  const approved = mkdtempSync(join(tmpdir(), "engineering-bridge-authorize-"));
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-authorize-config-"));
  const configPath = join(configDir, "workspaces.json");
  const managedProject = join(approved, "managed-project");
  const manualProject = join(approved, "manual-project");
  mkdirSync(managedProject);
  mkdirSync(manualProject);
  writeFileSync(configPath, `${JSON.stringify([
    { kind: "project_root", root: approved },
    { id: "manual", root: manualProject, allow_write: true }
  ], null, 2)}\n`);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body };
  };

  try {
    await client.connect(transport);

    const bound = await call("bind_project", {
      project_path: managedProject,
      confirmation: "BIND"
    });
    const workspaceId = (bound.body as { workspace_id?: string }).workspace_id;
    assert.equal(typeof workspaceId, "string");

    // AUTHORIZE a managed workspace: persisted in the catalog file.
    const authorized = await call("authorize_workspace_write", {
      workspace_id: workspaceId,
      confirmation: "AUTHORIZE"
    });
    assert.equal(authorized.isError, false);
    assert.deepEqual(authorized.body, { workspace_id: workspaceId, allow_write: true });
    const catalogFile = `${configPath}.managed-workspaces.json`;
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8")) as { workspaces: Array<{ id: string; allow_write?: boolean }> };
    assert.equal(catalog.workspaces.find(({ id }) => id === workspaceId)?.allow_write, true);

    // Idempotent on repeat.
    const again = await call("authorize_workspace_write", {
      workspace_id: workspaceId,
      confirmation: "AUTHORIZE"
    });
    assert.deepEqual(again.body, authorized.body);

    // Manual workspaces stay authoritative through workspaces.json.
    const manual = await call("authorize_workspace_write", {
      workspace_id: "manual",
      confirmation: "AUTHORIZE"
    });
    assert.equal(manual.isError, true);
    assert.deepEqual(manual.body, {
      error: {
        code: "WORKSPACE_PRECONDITION_FAILED",
        message: "The workspace preconditions were not met."
      }
    });

    // Unknown workspaces are unchanged.
    const missing = await call("authorize_workspace_write", {
      workspace_id: "missing",
      confirmation: "AUTHORIZE"
    });
    assert.equal(missing.isError, true);
    assert.deepEqual(missing.body, {
      error: {
        code: "UNKNOWN_WORKSPACE",
        message: "The requested workspace is not registered."
      }
    });

    // Wrong confirmation is rejected by the schema.
    const wrong = await call("authorize_workspace_write", {
      workspace_id: workspaceId,
      confirmation: "NO"
    });
    assert.equal(wrong.isError, true);
    assert.equal(JSON.stringify(wrong.body).includes("allow_write"), false);
  } finally {
    await client.close();
  }
});

test("generate_controlled_patch and refine_controlled_patch accept omitted/codex/dsh executor and reject unknown values", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-patch-executor-"));
  const configPath = join(configDir, "workspaces.json");
  writeFileSync(configPath, "[]\n");
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body };
  };

  try {
    await client.connect(transport);

    // Omitted, explicit codex, and explicit dsh all pass the schema; the
    // business layer then fails on the missing workspace, proving the request
    // reached the handler with the executor field accepted.
    for (const args of [
      { workspace_id: "missing", change_request: "change" },
      { workspace_id: "missing", change_request: "change", executor: "codex" },
      { workspace_id: "missing", change_request: "change", executor: "dsh" }
    ]) {
      const generated = await call("generate_controlled_patch", args);
      assert.equal(generated.isError, true);
      assert.deepEqual(generated.body, {
        error: {
          code: "UNKNOWN_WORKSPACE",
          message: "The requested workspace is not registered."
        }
      });
    }
    for (const args of [
      { patch_task_id: "missing", change_request: "refine" },
      { patch_task_id: "missing", change_request: "refine", executor: "codex" },
      { patch_task_id: "missing", change_request: "refine", executor: "dsh" }
    ]) {
      const refined = await call("refine_controlled_patch", args);
      assert.equal(refined.isError, true);
      assert.deepEqual(refined.body, {
        error: {
          code: "INVALID_STATE_TRANSITION",
          message: "The requested state transition is not allowed."
        }
      });
    }

    // Unknown executor values are rejected by the schema before any business
    // logic: the structured business error must not appear.
    const unknownGenerate = await call("generate_controlled_patch", {
      workspace_id: "missing",
      change_request: "change",
      executor: "unknown"
    });
    assert.equal(unknownGenerate.isError, true);
    assert.equal(JSON.stringify(unknownGenerate.body).includes("UNKNOWN_WORKSPACE"), false);

    const unknownRefine = await call("refine_controlled_patch", {
      patch_task_id: "missing",
      change_request: "refine",
      executor: "unknown"
    });
    assert.equal(unknownRefine.isError, true);
    assert.equal(JSON.stringify(unknownRefine.body).includes("INVALID_STATE_TRANSITION"), false);
  } finally {
    await client.close();
  }
});

test("submit_controlled_patch registers a submitted proposal and task_result reports source submitted without an executor", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-submit-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  isolateGitLineEndings(root);
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  writeFileSync(join(root, "note.txt"), "before\n");
  execFileSync("git", ["add", "note.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const validPatch = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-submit-config-"));
  const configPath = join(configDir, "workspaces.json");
  writeFileSync(configPath, `${JSON.stringify([{ id: "workspace", root, allow_write: true }], null, 2)}\n`);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body: body as Record<string, unknown> };
  };

  try {
    await client.connect(transport);

    const submitted = await call("submit_controlled_patch", {
      workspace_id: "workspace",
      base_head: head,
      diff: validPatch
    });
    assert.equal(submitted.isError, false);
    const taskId = submitted.body.task_id;
    assert.equal(typeof taskId, "string");
    assert.equal(submitted.body.base_head, head);
    if (typeof taskId !== "string") return;

    const view = await call("task_result", { task_id: taskId });
    assert.equal(view.body.state, "completed");
    assert.equal(view.body.source, "submitted");
    assert.equal("executor" in view.body, false);
    assert.equal(view.body.output, validPatch);

    const taskView = { ...view.body };
    delete taskView.mcp_diagnostics;
    const mcpDiagnostics = view.body.mcp_diagnostics as { serialized_task_view_bytes?: unknown } | undefined;
    assert.equal(
      mcpDiagnostics?.serialized_task_view_bytes,
      Buffer.byteLength(JSON.stringify(taskView), "utf8")
    );
    assert.equal(JSON.stringify(view.body.mcp_diagnostics).includes(validPatch), false);

    // A stale base_head is rejected with the structured preflight error.
    const stale = await call("submit_controlled_patch", {
      workspace_id: "workspace",
      base_head: "0".repeat(40),
      diff: validPatch
    });
    assert.equal(stale.isError, true);
    assert.deepEqual(stale.body, {
      error: {
        code: "WORKSPACE_PRECONDITION_FAILED",
        message: "The workspace preconditions were not met."
      }
    });

    // A submitted-but-not-applied proposal refuses exact COMMIT before APPLY.
    const earlyCommit = await call("commit_controlled_patch", {
      patch_task_id: taskId,
      message: "feat: commit submitted patch",
      confirmation: "COMMIT"
    });
    assert.equal(earlyCommit.isError, true);
    assert.deepEqual(earlyCommit.body, {
      raw: "The requested state transition is not allowed."
    });

    // The submitted proposal is applied through the existing APPLY tool.
    const applied = await call("apply_controlled_patch", {
      patch_task_id: taskId,
      confirmation: "APPLY"
    });
    assert.equal(applied.isError, false);
    assert.deepEqual(applied.body, { patch_task_id: taskId, applied: true, changed_paths: ["note.txt"] });
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");

    // Lowercase confirmation is rejected by the MCP input schema before any
    // business logic: the SDK validation prefix appears, no commit payload is
    // produced, and HEAD plus the applied tracked dirt stay untouched.
    const lowercased = await call("commit_controlled_patch", {
      patch_task_id: taskId,
      message: "feat: commit submitted patch",
      confirmation: "commit"
    });
    assert.equal(lowercased.isError, true);
    assert.equal(typeof lowercased.body.raw, "string");
    assert.match(
      String(lowercased.body.raw),
      /Input validation error: Invalid arguments for tool commit_controlled_patch:/u
    );
    assert.equal(JSON.stringify(lowercased.body).includes("committed"), false);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      head
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
      " M note.txt\n"
    );

    // Exact COMMIT creates one commit containing only the already-APPLYed proposal.
    const committed = await call("commit_controlled_patch", {
      patch_task_id: taskId,
      message: "feat: commit submitted patch",
      confirmation: "COMMIT"
    });
    assert.equal(committed.isError, false);
    assert.equal(committed.body.patch_task_id, taskId);
    assert.equal(committed.body.committed, true);
    assert.match(String(committed.body.commit_sha), /^[0-9a-f]{40,64}$/u);
    assert.equal(
      execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, encoding: "utf8" }).trim(),
      "feat: commit submitted patch"
    );
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      committed.body.commit_sha
    );
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
  } finally {
    await client.close();
  }
});

test("controlled patch validation tools enforce fixed schemas, confirmation, defaults, and fixed validation input", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-validation-mcp-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  isolateGitLineEndings(root);
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  writeFileSync(join(root, "note.txt"), "before\n");
  execFileSync("git", ["add", "note.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const validPatch = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

  const configDir = mkdtempSync(join(tmpdir(), "engineering-bridge-validation-mcp-config-"));
  const configPath = join(configDir, "workspaces.json");
  const profilePath = `${configPath}.validation-profiles.json`;
  writeFileSync(configPath, `${JSON.stringify([{ id: "workspace", root }], null, 2)}\n`);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body: body as Record<string, unknown> };
  };

  const profile = {
    preparation: [],
    validation: [{ name: "test", argv: ["npm", "test"] }]
  };

  try {
    await client.connect(transport);

    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const configureSchema = tools.get("configure_validation_profile")?.inputSchema as {
      properties?: Record<string, { const?: unknown }>;
      additionalProperties?: boolean;
    } | undefined;
    assert.equal(configureSchema?.properties?.confirmation?.const, "CONFIGURE");
    assert.equal(configureSchema?.additionalProperties, false);

    const validationSchema = tools.get("validate_controlled_patch")?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    } | undefined;
    assert.deepEqual(Object.keys(validationSchema?.properties ?? {}), ["patch_task_id"]);
    assert.deepEqual(validationSchema?.required, ["patch_task_id"]);
    assert.equal(validationSchema?.additionalProperties, false);

    const submitted = await call("submit_controlled_patch", {
      workspace_id: "workspace",
      base_head: head,
      diff: validPatch
    });
    assert.equal(submitted.isError, false);
    const patchTaskId = submitted.body.task_id;
    assert.equal(typeof patchTaskId, "string");
    if (typeof patchTaskId !== "string") return;

    const missingProfile = await call("validate_controlled_patch", {
      patch_task_id: patchTaskId
    });
    assert.equal(missingProfile.isError, false);
    assert.equal(missingProfile.body.status, "INCOMPLETE");
    assert.equal(missingProfile.body.reason, "validation_profile_missing");

    for (const args of [
      { patch_task_id: patchTaskId, command: "npm test" },
      { patch_task_id: patchTaskId, timeout_seconds: 1 }
    ]) {
      const rejected = await call("validate_controlled_patch", args);
      assert.equal(rejected.isError, true);
      assert.equal(JSON.stringify(rejected.body).includes("validation_profile_missing"), false);
    }

    for (const confirmation of ["AUTHORIZE", "configure", undefined]) {
      const rejected = await call("configure_validation_profile", {
        workspace_id: "workspace",
        profile,
        ...(confirmation === undefined ? {} : { confirmation })
      });
      assert.equal(rejected.isError, true);
      assert.equal(existsSync(profilePath), false);
    }

    const emptyArgv = await call("configure_validation_profile", {
      workspace_id: "workspace",
      profile: {
        preparation: [],
        validation: [{ name: "test", argv: [] }]
      },
      confirmation: "CONFIGURE"
    });
    assert.equal(emptyArgv.isError, true);
    assert.equal(existsSync(profilePath), false);

    const configured = await call("configure_validation_profile", {
      workspace_id: "workspace",
      profile,
      confirmation: "CONFIGURE"
    });
    assert.equal(configured.isError, false);
    assert.deepEqual(JSON.parse(readFileSync(profilePath, "utf8")), {
      version: 1,
      profiles: [{
        workspace_id: "workspace",
        preparation: [],
        validation: [{ name: "test", argv: ["npm", "test"] }],
        default_step_timeout_seconds: 600,
        total_timeout_seconds: 1200
      }]
    });
  } finally {
    await client.close();
  }
});

test("malformed validation profile state stays lazy for startup, listing, and an existing safe tool path", async () => {
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-validation-lazy-")));
  const configPath = join(configDir, "workspaces.json");
  const profilePath = `${configPath}.validation-profiles.json`;
  writeFileSync(configPath, `${JSON.stringify([{ id: "workspace", root: configDir }], null, 2)}\n`);
  writeFileSync(profilePath, "{not-json\n");

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as ToolResult["content"];
    const text = content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = { raw: text };
    }
    return { isError: result.isError === true, body: body as Record<string, unknown> };
  };

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some(({ name }) => name === "validate_controlled_patch"), true);

    const run = await call("run_task", {
      workspace_id: "missing",
      instruction: "inspect",
      executor: "dsh"
    });
    assert.equal(run.isError, false);
    assert.equal(typeof run.body.task_id, "string");
    assert.equal(readFileSync(profilePath, "utf8"), "{not-json\n");

    const configuration = await call("configure_validation_profile", {
      workspace_id: "workspace",
      profile: { preparation: [], validation: [] },
      confirmation: "CONFIGURE"
    });
    assert.equal(configuration.isError, true);
    assert.deepEqual(configuration.body, {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed."
      }
    });
    assert.equal(readFileSync(profilePath, "utf8"), "{not-json\n");
  } finally {
    await client.close();
  }
});
