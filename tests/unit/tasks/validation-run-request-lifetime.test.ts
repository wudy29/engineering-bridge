import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { validationFixture, until } from "../../helpers/validation-run-fixture.js";
import { ControlledPatchValidationRunService as Service } from "../../../src/tasks/controlled-patch-validation-run-service.js";
import { ValidationProcessRunner } from "../../../src/tasks/validation-process-runner.js";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
for (const cancel of [false, true]) test("private MCP fixture " + (cancel ? "cancellation" : "response and disconnect") + " leaves service-owned execution alive", async t => {
  const f = await validationFixture(t);
  const execute = deferred(), entered = deferred(), reply = deferred(), admitted = deferred();
  t.after(() => { execute.resolve(); reply.resolve(); });
  const real = new ValidationProcessRunner(); let executions = 0;
  const service = await Service.open({ registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], runner: { async runSupervised(request, control) {
    if (request.argv[0] !== "git") { executions++; entered.resolve(); await execute.promise; assert.equal(control.signal.aborted, false); }
    return real.runSupervised(request, control);
  } } });
  f.cleanup.push(() => service.shutdown());
  let id: string | undefined, handlerSignal: AbortSignal | undefined;
  // Test-only transport seam: this does not register any production MCP tool.
  const session = async () => {
    const server = new Server({ name: "private-lifecycle-fixture", version: "0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === "fixture_start") {
        handlerSignal = extra.signal;
        const run = await service.start({ patch_task_id: f.patchTaskId, idempotency_key: "network-retry" });
        id = run.validation_run_id; admitted.resolve(); if (cancel) await reply.promise;
        return { content: [{ type: "text", text: JSON.stringify(run) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await service.get(id!)) }] };
    });
    const client = new Client({ name: "private-caller", version: "0" });
    const [caller, host] = InMemoryTransport.createLinkedPair();
    await server.connect(host); await client.connect(caller);
    f.cleanup.push(() => server.close()); f.cleanup.push(() => client.close());
    return client;
  };
  const client = await session();
  const stop = new AbortController();
  const call = client.request({ method: "tools/call", params: { name: "fixture_start", arguments: {} } }, CallToolResultSchema, { signal: stop.signal });
  const settled = call.then(x => ({ ok: true, x }), () => ({ ok: false }));
  await admitted.promise;
  if (cancel) { stop.abort(); assert.equal((await settled).ok, false); await until(async () => handlerSignal?.aborted === true); }
  else assert.equal((await settled).ok, true);
  await client.close(); reply.resolve(); await entered.promise;
  assert.equal((await service.get(id!))?.state, "running"); execute.resolve();
  await until(async () => (await service.get(id!))?.state === "terminal");
  const connected = await session();
  const queried = await connected.request({ method: "tools/call", params: { name: "fixture_query", arguments: {} } }, CallToolResultSchema);
  assert.equal(JSON.parse((queried.content[0] as { text: string }).text).status, "PASS");
  assert.equal(executions, 1);
  const before = await fs.readFile(join(f.directory, id! + ".json"), "utf8");
  assert.equal((await service.start({ patch_task_id: f.patchTaskId, idempotency_key: "network-retry" })).validation_run_id, id);
  assert.equal(await fs.readFile(join(f.directory, id! + ".json"), "utf8"), before);
});
