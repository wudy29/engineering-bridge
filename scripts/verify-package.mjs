import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

// A separate source copy, pack destination, and consumer. Never publish or use
// real workspace configuration; the only records are synthetic smoke fixtures.
const source = process.cwd();
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run verify:package");
// --consume never packs or builds: it installs the producer's original bytes.
const consume = process.argv[2] === "--consume";
const inputTgz = consume ? resolve(process.argv[3]) : undefined;
const inputManifest = consume ? resolve(process.argv[4]) : undefined;
const keep = process.argv[consume ? 5 : 2];
const root = await fs.realpath(await fs.mkdtemp(join(keep ? resolve(keep) : tmpdir(), "bridge-package-")));
const staging = join(root, "source"), consumer = join(root, "consumer");
const marker = "PRIVATE_PACK_SENTINEL_" + randomUUID();
const baseline = JSON.parse(await fs.readFile(join(source, "tests/fixtures/mcp-tools-v1.6.0.json"), "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const declared = JSON.parse(await fs.readFile(join(source, "package.json"), "utf8"));
const lockBytes = await fs.readFile(join(source, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const expectedSchema = { ...baseline, server: { ...baseline.server, version: declared.version } };
const publicDocs = new Set([
  "2026-08-27-execution-usage-decision.md", "architecture.md", "security.md", "threat-model.md", "tools.md",
  "plans/2026-08-15-multi-executor-dsh.md",
  "superpowers/plans/2026-08-26-perf-restore-1-bulk-controlled-patch-hydration.md",
  "superpowers/plans/2026-08-26-red-5b-durable-applied-before-unpin.md",
  "superpowers/plans/2026-08-27-controlled-patch-validation.md",
  "superpowers/plans/2026-08-30-controlled-commit-implementation-plan.md",
  "superpowers/specs/2026-08-08-alpha4-first-use-project-onboarding-design.md",
  "superpowers/specs/2026-08-26-controlled-patch-lifecycle-design.md",
  "superpowers/specs/2026-08-27-controlled-patch-validation-design.md",
  "superpowers/specs/2026-08-30-exact-upstream-bootstrap-and-controlled-commit-design.md",
]);
function npm(args, cwd, log) {
  try {
    const output = execFileSync(process.execPath, [npmCli, ...args], {
      cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return fs.writeFile(join(root, log), output).then(() => output);
  } catch (error) {
    return fs.writeFile(join(root, log), String(error.stdout ?? "") + String(error.stderr ?? ""))
      .then(() => { throw error; });
  }
}
try {
  await fs.mkdir(consumer);
  let tgz, packageManifest;
  const privatePaths = [".env", ".ssh/id_ed25519", "credentials.json", "config/workspaces.json",
    "config/private-token.json", "records/proposals.json", "tests/private-output.txt", "var/validation-runs/private.json"];
  if (consume) {
    tgz = inputTgz;
    packageManifest = JSON.parse(await fs.readFile(inputManifest, "utf8"));
  } else {
    await fs.mkdir(staging);
    for (const name of ["src", "tests", "config", "docs", "package.json", "package-lock.json", "tsconfig.json",
      "README.md", "README.zh-CN.md", "RELEASE_NOTES.md", "SECURITY.md", "CONTRIBUTING.md", "LICENSE"]) {
      await fs.cp(join(source, name), join(staging, name), { recursive: true });
    }
    await fs.symlink(join(source, "node_modules"), join(staging, "node_modules"), "junction");
    for (const path of privatePaths) {
      await fs.mkdir(dirname(join(staging, path)), { recursive: true });
      await fs.writeFile(join(staging, path), marker);
    }
    const output = await npm(["pack", "--json", "--silent", "--pack-destination", root], staging, "pack.log");
    const [packed] = JSON.parse(output);
    const paths = packed.files.map(file => file.path).sort();
    for (const path of paths) {
      assert.ok(/^dist\/src\/.+\.js$/u.test(path) ||
        (path.startsWith("docs/") && publicDocs.has(path.slice(5))) ||
        /^(config\/workspaces\.example\.json|package\.json|README(?:\.zh-CN)?\.md|RELEASE_NOTES\.md|SECURITY\.md|CONTRIBUTING\.md|LICENSE)$/u.test(path), path);
      assert.ok(!(await fs.readFile(join(staging, path))).includes(Buffer.from(marker)), path);
    }
    for (const path of privatePaths) assert.ok(!paths.includes(path), path);
    tgz = join(root, packed.filename);
    packageManifest = { version: declared.version, sha256: sha256(await fs.readFile(tgz)), integrity: packed.integrity,
      packageJsonSha256: sha256(await fs.readFile(join(source, "package.json"))), lockSha256: sha256(lockBytes),
      producer: { platform: process.platform, node: process.version, npm: await npm(["--version"], source, "npm-version.log"),
        commit: process.env.GITHUB_SHA ?? null, candidateTree: process.env.BRIDGE_CANDIDATE_TREE ?? null },
      files: await Promise.all(paths.map(async path => ({ path, sha256: sha256(await fs.readFile(join(staging, path))),
        size: (await fs.stat(join(staging, path))).size }))), privateSentinelsExcluded: privatePaths };
  }
  assert.equal(packageManifest.version, declared.version);
  assert.equal(packageManifest.sha256, sha256(await fs.readFile(tgz)), "original tgz digest");
  assert.equal(packageManifest.integrity, "sha512-" + createHash("sha512").update(await fs.readFile(tgz)).digest("base64"));
  assert.equal(packageManifest.packageJsonSha256, sha256(await fs.readFile(join(source, "package.json"))));
  assert.equal(packageManifest.lockSha256, sha256(lockBytes));
  await fs.writeFile(join(root, "package-manifest.json"), JSON.stringify(packageManifest, null, 2) + "\n");
  const paths = packageManifest.files.map(file => file.path).sort();
  const manifest = { name: "bridge-packed-smoke", version: "0.0.0", private: true,
    dependencies: { "engineering-bridge": "file:" + tgz } };
  // Install the tgz against the already reviewed runtime dependency graph.
  // This gate must not silently resolve newer versions from dependency ranges.
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, item]) => path && !item.dev));
  packages[""] = manifest;
  packages["node_modules/engineering-bridge"] = { version: declared.version, resolved: "file:" + tgz,
    integrity: packageManifest.integrity, dependencies: declared.dependencies, bin: declared.bin, engines: declared.engines };
  await fs.writeFile(join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(join(consumer, "package-lock.json"), JSON.stringify({ name: manifest.name, version: manifest.version,
    lockfileVersion: 3, requires: true, packages }, null, 2));
  const consumerLock = await fs.readFile(join(consumer, "package-lock.json"));
  await npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, "install.log");
  assert.deepEqual(await fs.readFile(join(consumer, "package-lock.json")), consumerLock, "install must not resolve a different lock");
  for (const [path, item] of Object.entries(packages)) {
    if (!path) continue;
    const actual = JSON.parse(await fs.readFile(join(consumer, path, "package.json"), "utf8"));
    assert.equal(actual.version, item.version, path);
  }
  const installed = join(consumer, "node_modules/engineering-bridge");
  async function installedFiles(directory, prefix = "") {
    const result = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) result.push(...await installedFiles(join(directory, entry.name), path + "/"));
      else { assert.equal(entry.isFile(), true, path); result.push(path); }
    }
    return result.sort();
  }
  assert.deepEqual(await installedFiles(installed), paths, "installed public member inventory");
  for (const file of packageManifest.files) {
    const bytes = await fs.readFile(join(installed, file.path));
    assert.equal(sha256(bytes), file.sha256, file.path); assert.equal(bytes.length, file.size, file.path);
  }
  const metadata = JSON.parse(await fs.readFile(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.version, declared.version);
  const shim = join(consumer, "node_modules/.bin/engineering-bridge" + (process.platform === "win32" ? ".cmd" : ""));
  await fs.access(shim);
  const workspace = join(root, "fixture"); await fs.mkdir(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Package Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false"); git("config", "commit.gpgSign", "false");
  const hooks = join(root, "empty-hooks"); await fs.mkdir(hooks); git("config", "core.hooksPath", hooks);
  await fs.writeFile(join(workspace, "note.txt"), "before\n"); git("add", "note.txt"); git("commit", "-qm", "fixture base");
  const baseHead = git("rev-parse", "HEAD"), indexBefore = await fs.readFile(join(workspace, ".git/index"));
  const worktreesBefore = git("worktree", "list", "--porcelain");
  const config = join(root, "workspaces.json"); await fs.writeFile(config, JSON.stringify([{ id: "fixture", root: workspace }]));
  const client = new Client({ name: "packed-install-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: shim,
    args: [config],
    cwd: consumer, stderr: "pipe",
  });
  let captured, validation;
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const tools = []; let cursor;
    do {
      // Keep raw tool objects, including unknown or absent optional fields.
      const page = await client.request({ method: "tools/list", params: cursor === undefined ? {} : { cursor } },
        z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional() }));
      tools.push(...page.tools); cursor = page.nextCursor;
    } while (cursor !== undefined);
    captured = { server: client.getServerVersion(), tools: tools.sort((a, b) => a.name.localeCompare(b.name)) };
    await fs.writeFile(join(root, "schema.json"), JSON.stringify(captured, null, 2) + "\n");
    assert.equal(tools.length, 15); assert.deepEqual(captured, expectedSchema);
    const legacy = await client.callTool({ name: "task_result", arguments: { task_id: "missing", extra: marker } });
    assert.doesNotMatch(JSON.stringify(legacy), /Input validation error|PRIVATE_PACK_SENTINEL/u);
    for (const [name, args] of [
      ["configure_validation_profile", { workspace_id: "missing", profile: { preparation: [], validation: [] }, confirmation: "CONFIGURE" }],
      ["validate_controlled_patch", { patch_task_id: "missing" }],
      ["start_controlled_patch_validation", { patch_task_id: "missing", idempotency_key: "smoke" }],
      ["get_controlled_patch_validation", { validation_run_id: "00000000-0000-4000-8000-000000000000" }],
    ]) {
      const result = await client.callTool({ name, arguments: { ...args, extra: marker } });
      assert.equal(result.isError, true); assert.match(JSON.stringify(result), /Input validation error/u);
    }
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      await fs.appendFile(join(root, "calls.jsonl"), JSON.stringify({ name, result }) + "\n");
      const body = JSON.parse(result.content.find(item => item.type === "text").text);
      return { error: result.isError === true, body };
    };
    const ok = async (name, args) => { const result = await call(name, args); assert.equal(result.error, false, JSON.stringify(result)); return result.body; };
    const proposal = await ok("submit_controlled_patch", { workspace_id: "fixture", base_head: baseHead,
      diff: "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n" });
    const proposalBefore = await fs.readFile(config + ".controlled-patches.json");
    const ran = join(root, "profile-ran");
    await ok("configure_validation_profile", { workspace_id: "fixture", confirmation: "CONFIGURE", profile: {
      preparation: [], validation: [{ name: "candidate", argv: [process.execPath, "-e",
        `const fs=require('node:fs');if(fs.readFileSync('note.txt','utf8')!=='after\\n')process.exit(91);fs.appendFileSync(${JSON.stringify(ran)},'ran\\n');`], timeout_seconds: 10 }],
      default_step_timeout_seconds: 10, total_timeout_seconds: 30 } });
    const sync = await ok("validate_controlled_patch", { patch_task_id: proposal.task_id });
    // Save the real result before assertions or transport teardown.
    validation = { sync }; await fs.writeFile(join(root, "validation.json"), JSON.stringify(validation, null, 2));
    assert.equal(sync.cleanup, "success"); assert.equal(sync.base_head, baseHead); assert.equal(sync.patch_task_id, proposal.task_id);
    if (process.platform === "win32") {
      assert.equal(sync.status, "INCOMPLETE"); assert.equal(sync.reason, "unsupported_platform"); assert.deepEqual(sync.steps, []);
      assert.equal(await fs.access(ran).then(() => true, () => false), false);
      const asyncResult = await call("start_controlled_patch_validation", { patch_task_id: proposal.task_id, idempotency_key: "package" });
      validation.async = asyncResult; assert.equal(asyncResult.error, true);
      assert.equal(asyncResult.body.error.code, "VALIDATION_PLATFORM_UNSUPPORTED");
    } else {
      assert.equal(sync.status, "PASS"); assert.equal(sync.steps.length, 1);
      assert.equal(await fs.readFile(ran, "utf8"), "ran\n");
      const run = await ok("start_controlled_patch_validation", { patch_task_id: proposal.task_id, idempotency_key: "package" });
      const deadline = performance.now() + 8000;
      do {
        validation.async = await ok("get_controlled_patch_validation", { validation_run_id: run.validation_run_id });
        if (validation.async.state === "terminal") break;
        assert.ok(performance.now() < deadline, "package async validation deadline"); await delay(10);
      } while (true);
      await fs.writeFile(join(root, "validation.json"), JSON.stringify(validation, null, 2));
      assert.equal(validation.async.status, "PASS"); assert.equal(validation.async.cleanup.state, "success");
      assert.equal(await fs.readFile(ran, "utf8"), "ran\nran\n");
    }
    assert.equal(git("rev-parse", "HEAD"), baseHead); assert.equal(git("worktree", "list", "--porcelain"), worktreesBefore);
    assert.deepEqual(await fs.readFile(join(workspace, ".git/index")), indexBefore);
    assert.equal(await fs.readFile(join(workspace, "note.txt"), "utf8"), "before\n");
    assert.deepEqual(await fs.readFile(config + ".controlled-patches.json"), proposalBefore);
    await fs.writeFile(join(root, "validation.json"), JSON.stringify(validation, null, 2));
  } finally {
    try {
      if (validation) await fs.writeFile(join(root, "validation.json"), JSON.stringify(validation, null, 2));
      await fs.writeFile(join(root, "stderr.log"), stderr);
    } finally { await client.close(); }
  }
  const result = { status: "PASS", platform: process.platform, node: process.version, tgz,
    sha256: createHash("sha256").update(await fs.readFile(tgz)).digest("hex"), files: paths,
    privateSentinelsExcluded: privatePaths, installedBytesEqual: true, lockedDependenciesEqual: true,
    schemaDeepEqual: true, launcher: shim, nativeCmdWrapper: process.platform === "win32", tools: captured.tools.length,
    version: metadata.version, mode: consume ? "consume-original" : "produce-and-consume", validation };
  await fs.writeFile(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, evidence: keep ? root : "temporary artifacts removed" }, null, 2));
} catch (error) {
  await fs.writeFile(join(root, "failure.json"), JSON.stringify({ status: "FAIL", platform: process.platform,
    node: process.version, message: error.message, stack: error.stack }, null, 2));
  throw error;
} finally {
  if (!keep) await fs.rm(root, { recursive: true, force: true });
}
