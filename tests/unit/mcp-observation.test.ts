import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ObservationEnvelope } from "../../src/observability/observation-publisher.js";
import { VERSION } from "../../src/version.js";
import { until } from "../helpers/validation-run-fixture.js";

const expectedTools = [
  "run_task", "task_result", "control_task", "bind_project", "create_project",
  "authorize_workspace_write", "generate_controlled_patch", "refine_controlled_patch",
  "submit_controlled_patch", "apply_controlled_patch", "commit_controlled_patch",
  "configure_validation_profile", "validate_controlled_patch",
  "start_controlled_patch_validation", "get_controlled_patch_validation",
].sort();
const bridge = new URL("../../src/mcp-stdio.js", import.meta.url);
const store = new URL("../../src/observability/observation-store.js", import.meta.url);
const dsh = new URL("../../src/executors/dsh-executor.js", import.meta.url);

test("real run_task observations preserve outcomes, the full tool catalog and EOF exit status across sink failures", { timeout: 30_000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-mcp-observation-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await fs.mkdir(workspace);
  let baseline: unknown;
  for (const mode of ["normal", "blocked", "rejected", "stalled", "timer-failure"] as const) {
    const config = join(root, mode + ".json");
    const directory = config + ".observations";
    const entered = join(root, mode + ".entered");
    await fs.writeFile(config, JSON.stringify([{ id: "workspace", root: workspace }]));
    if (mode === "blocked") await fs.writeFile(directory, "occupied");
    // Preload only in this fixture's child; the MCP handler and task service stay real.
    const observationInjection = mode === "rejected" || mode === "stalled"
      ? `import { ObservationStore } from ${JSON.stringify(store.href)};
         import { writeFileSync } from "node:fs";
         ObservationStore.prototype.write = () => {
           writeFileSync(${JSON.stringify(entered)}, "entered");
           return ${mode === "stalled"
             ? "new Promise(() => {})" : "Promise.reject(new Error('injected observation I/O failure'))"};
         };`
      : mode === "timer-failure"
        ? `const original = globalThis.setInterval;
           globalThis.setInterval = (callback, delay, ...args) => {
             if (delay === 5000) throw new Error("injected timer startup failure");
             return original(callback, delay, ...args);
           };`
        : "";
    const injection = `
      import { DshExecutor } from ${JSON.stringify(dsh.href)};
      DshExecutor.prototype.execute = async () => ({ kind: "completed", output: "fixture review output" });
      ${observationInjection}
    `;
    const child = spawn(process.execPath, [
      "--import", "data:text/javascript," + encodeURIComponent(injection),
      fileURLToPath(bridge), config,
    ], { env: getDefaultEnvironment(), stdio: "pipe", shell: false });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.on("error", () => undefined);
    const finished = new Promise<void>(resolve => child.once("close", () => resolve()));
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const client = new Client({ name: "observation-test", version: "0" });
    const transport = new StdioServerTransport(child.stdout, child.stdin);
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), expectedTools);
      if (mode === "normal") baseline = catalog;
      else assert.deepEqual(catalog, baseline, mode);
      const result = await client.callTool({ name: "task_result", arguments: { task_id: "unknown" } });
      assert.equal(result.isError, true);
      if (mode === "normal") {
        await until(async () => {
          try { return (await fs.readdir(directory)).some(name => name.endsWith(".json")); }
          catch { return false; }
        });
        const records = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
        assert.equal(records.length, 1);
        const record = JSON.parse(await fs.readFile(join(directory, records[0]!), "utf8")) as ObservationEnvelope;
        assert.equal(record.kind, "producer");
        assert.equal(record.producer_id, record.record_id);
        assert.equal(record.metadata.pid, child.pid);
        assert.equal(record.metadata.bridge_version, VERSION);
        assert.deepEqual(Object.keys(record.metadata).sort(), ["bridge_version", "pid", "started_at"]);
      }
      if (mode === "rejected" || mode === "stalled") {
        await until(async () => {
          try { return await fs.readFile(entered, "utf8") === "entered"; }
          catch { return false; }
        });
      }
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.request({
          method: "tools/call", params: { name, arguments: args }
        }, CallToolResultSchema);
        assert.notEqual(response.isError, true);
        const text = response.content.find(item => item.type === "text");
        assert.ok(text?.type === "text");
        return JSON.parse(text.text) as Record<string, unknown>;
      };
      const { task_id: taskId } = await call("run_task", {
        workspace_id: "workspace", instruction: "private instruction", executor: "dsh"
      });
      assert.equal(typeof taskId, "string");
      await until(async () => {
        const view = await call("task_result", { task_id: taskId });
        if (view.state !== "waiting_for_supervisor_review") return false;
        assert.equal(view.review_output, "fixture review output");
        return true;
      });
      if (mode === "normal") {
        let taskRecords: ObservationEnvelope[] = [];
        await until(async () => {
          const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
          taskRecords = await Promise.all(names.map(async name =>
            JSON.parse(await fs.readFile(join(directory, name), "utf8")) as ObservationEnvelope));
          return taskRecords.some(record => record.kind === "task" && record.record_id === taskId &&
            record.metadata.state === "waiting_for_supervisor_review");
        });
        const taskRecord = taskRecords.find(record => record.kind === "task" && record.record_id === taskId);
        assert.ok(taskRecord);
        assert.equal(taskRecord.record_id, taskId);
        assert.deepEqual(taskRecord.metadata, {
          task_id: taskId, state: "waiting_for_supervisor_review", executor: "dsh",
          requested_model: null, requested_reasoning_effort: null,
          created_at: taskRecord.metadata.created_at, started_at: taskRecord.metadata.started_at,
          ended_at: null
        });
        for (const field of ["created_at", "started_at"]) {
          const value: unknown = taskRecord.metadata[field];
          assert.equal(typeof value, "string");
          assert.equal(new Date(value as string).toISOString(), value);
        }
        assert.ok(String(taskRecord.metadata.started_at) >= String(taskRecord.metadata.created_at));
        assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".json")).length, 2);
      }
      assert.deepEqual(await client.listTools(), baseline, mode);
      // This tests normal finite filesystem I/O and an unresolved sink promise.
      // It does not claim that Node can cancel a blocked kernel filesystem request.
      await client.close();
      child.stdin.end();
      child.stdout.resume();
      await until(async () => exited(), 5000);
      await finished;
      assert.equal(child.exitCode, 0, mode + ": " + stderr);
      assert.equal(child.signalCode, null);
      assert.equal(stderr, "", mode);
    } finally {
      await client.close();
      child.stdin.end();
      child.stdout.resume();
      if (!exited()) child.kill("SIGTERM");
      await until(async () => exited(), 5000);
      await finished;
    }
  }
});
