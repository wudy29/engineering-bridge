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

test("optional observation failures/stalls preserve the full tool catalog and EOF exit status", { timeout: 30_000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-mcp-observation-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let baseline: unknown;
  for (const mode of ["normal", "blocked", "rejected", "stalled", "timer-failure"] as const) {
    const config = join(root, mode + ".json");
    const directory = config + ".observations";
    const entered = join(root, mode + ".entered");
    await fs.writeFile(config, "[]");
    if (mode === "blocked") await fs.writeFile(directory, "occupied");
    // Preload only in this fixture's child. Never replace Bridge execution services.
    const injection = mode === "rejected" || mode === "stalled"
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
