import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isolateGitLineEndings } from "./git-fixture.js";
import { PATCH, until } from "./validation-run-fixture.js";

export { until };
export async function mcpValidationFixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-mcp-async-")));
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  const workspace = join(root, "project"); await fs.mkdir(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); isolateGitLineEndings(workspace);
  git("config", "user.name", "MCP Validation Fixture"); git("config", "user.email", "validation@example.test");
  await fs.writeFile(join(workspace, "note.txt"), "before\n");
  git("add", "note.txt"); git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture base");
  const baseHead = git("rev-parse", "HEAD").trim();
  const config = join(root, "workspaces.json");
  await fs.writeFile(config, JSON.stringify([{ id: "workspace", root: workspace }]));
  const directory = config + ".validation-runs";
  const counter = join(root, "executions");
  const ready = join(root, "ready");
  const release = join(root, "release");

  async function session(configPath = config) {
    const child = spawn(process.execPath, [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath], {
      cwd: process.cwd(), env: getDefaultEnvironment(), stdio: "pipe", shell: false,
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
    child.stdin.on("error", () => undefined);
    const finished = new Promise<void>(resolve => child.once("close", () => resolve()));
    const client = new Client({ name: "async-validation-e2e", version: "0" });
    // The SDK stdio codec is symmetric. This fixture owns the child separately:
    // disconnecting the caller must not secretly send SIGTERM as client/stdio.close does.
    const transport = new StdioServerTransport(child.stdout, child.stdin);
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const close = async () => {
      await client.close(); child.stdout.resume(); child.stdin.end();
      if (!exited()) child.kill("SIGTERM");
      try { await until(async () => exited(), 10_000); }
      finally { if (!exited()) child.kill("SIGKILL"); }
      await finished;
    };
    cleanup.push(close);
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>, timeout = 2500) => {
      const result = await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, { timeout });
      const text = result.content.find(item => item.type === "text");
      let body: Record<string, unknown>;
      try { body = JSON.parse(text?.type === "text" ? text.text : "{}"); }
      catch { body = { raw: text?.type === "text" ? text.text : "" }; }
      return { isError: result.isError === true, body };
    };
    const ok = async (name: string, args: Record<string, unknown>, timeout?: number) => {
      const result = await call(name, args, timeout);
      assert.equal(result.isError, false, JSON.stringify(result.body) + " " + stderr);
      return result.body;
    };
    return { client, child, call, ok, close, exited, finished,
      async disconnect() { await client.close(); child.stdin.end(); child.stdout.resume(); },
      async signal(signal: "SIGTERM" | "SIGKILL") { child.kill(signal); await until(async () => exited(), 10_000); await finished; },
    };
  }
  const connected = await session();
  const submitted = await connected.ok("submit_controlled_patch", { workspace_id: "workspace", base_head: baseHead, diff: PATCH });
  assert.equal(typeof submitted.task_id, "string");
  const patchTaskId = submitted.task_id as string;
  const proposalSource = await fs.readFile(config + ".controlled-patches.json", "utf8");
  const profile = (code: string, stepSeconds = 10) => ({
    preparation: [{ name: "prepare", argv: [process.execPath, "-e", "process.stdout.write('prepared')"] }],
    validation: [{ name: "check", argv: [process.execPath, "-e", code], timeout_seconds: stepSeconds }],
    default_step_timeout_seconds: stepSeconds, total_timeout_seconds: 30,
  });
  const script = (body = "process.stdout.write('validated')") =>
    `const fs=require('node:fs');if(fs.readFileSync('note.txt','utf8')!=='after\\n')process.exit(91);fs.appendFileSync(${JSON.stringify(counter)},'run\\n');${body}`;
  const blocking = () => script(`fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('validated');}},10);`);
  const configure = async (code: string, stepSeconds = 10) => connected.ok("configure_validation_profile", {
    workspace_id: "workspace", profile: profile(code, stepSeconds), confirmation: "CONFIGURE",
  });
  const readRun = async (id: string) => JSON.parse(await fs.readFile(join(directory, id + ".json"), "utf8"));
  // Raw rename visibility precedes directory fsync/publication. Wait for the
  // public committed snapshot before asserting a terminal query or revalidation.
  const waitForTerminal = (id: string) => until(async () =>
    (await connected.ok("get_controlled_patch_validation", { validation_run_id: id })).state === "terminal");
  const untouched = async () => {
    assert.equal(await fs.readFile(join(workspace, "note.txt"), "utf8"), "before\n");
    assert.equal(git("status", "--short"), ""); assert.equal(git("rev-parse", "HEAD").trim(), baseHead);
    assert.equal(await fs.readFile(config + ".controlled-patches.json", "utf8"), proposalSource,
      "validation must not change retained proposal lifecycle or applied history");
  };
  return { root, workspace, config, directory, counter, ready, release, baseHead, patchTaskId,
    session, connected, configure, profile, script, blocking, readRun, waitForTerminal, untouched, cleanup, git };
}
