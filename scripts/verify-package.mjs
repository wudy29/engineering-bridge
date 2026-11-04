import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// A separate source copy, pack destination, and consumer. Never publish or use
// real workspace configuration; the only records are synthetic smoke fixtures.
const source = process.cwd();
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run through npm run verify:package");
const keep = process.argv[2];
const root = await fs.mkdtemp(join(keep ? resolve(keep) : tmpdir(), "bridge-package-"));
const staging = join(root, "source"), consumer = join(root, "consumer");
const marker = "PRIVATE_PACK_SENTINEL_" + randomUUID();
const baseline = JSON.parse(await fs.readFile(join(source, "tests/fixtures/mcp-tools-v1.6.0.json"), "utf8"));
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
  await fs.mkdir(staging); await fs.mkdir(consumer);
  for (const name of ["src", "tests", "config", "docs", "package.json", "package-lock.json", "tsconfig.json",
    "README.md", "README.zh-CN.md", "RELEASE_NOTES.md", "SECURITY.md", "CONTRIBUTING.md", "LICENSE"]) {
    await fs.cp(join(source, name), join(staging, name), { recursive: true });
  }
  await fs.symlink(join(source, "node_modules"), join(staging, "node_modules"), "junction");
  const privatePaths = [".env", ".ssh/id_ed25519", "credentials.json", "config/workspaces.json",
    "config/private-token.json", "records/proposals.json", "tests/private-output.txt", "var/validation-runs/private.json"];
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
  const tgz = join(root, packed.filename);
  const declared = JSON.parse(await fs.readFile(join(staging, "package.json"), "utf8"));
  const lock = JSON.parse(await fs.readFile(join(staging, "package-lock.json"), "utf8"));
  const manifest = { name: "bridge-packed-smoke", version: "0.0.0", private: true,
    dependencies: { "engineering-bridge": "file:" + tgz } };
  // Install the tgz against the already reviewed runtime dependency graph.
  // This gate must not silently resolve newer versions from dependency ranges.
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([path, item]) => path && !item.dev));
  packages[""] = manifest;
  packages["node_modules/engineering-bridge"] = { version: declared.version, resolved: "file:" + tgz,
    integrity: packed.integrity, dependencies: declared.dependencies, bin: declared.bin, engines: declared.engines };
  await fs.writeFile(join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(join(consumer, "package-lock.json"), JSON.stringify({ name: manifest.name, version: manifest.version,
    lockfileVersion: 3, requires: true, packages }, null, 2));
  await npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], consumer, "install.log");
  for (const [path, item] of Object.entries(packages)) {
    if (!path) continue;
    const actual = JSON.parse(await fs.readFile(join(consumer, path, "package.json"), "utf8"));
    assert.equal(actual.version, item.version, path);
  }
  const installed = join(consumer, "node_modules/engineering-bridge");
  for (const path of paths) {
    assert.deepEqual(await fs.readFile(join(installed, path)), await fs.readFile(join(staging, path)), path);
  }
  const metadata = JSON.parse(await fs.readFile(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.version, baseline.server.version);
  const shim = join(consumer, "node_modules/.bin/engineering-bridge" + (process.platform === "win32" ? ".cmd" : ""));
  await fs.access(shim);
  const config = join(root, "workspaces.json"); await fs.writeFile(config, "[]\n");
  const client = new Client({ name: "packed-install-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: shim,
    args: [config],
    cwd: consumer, stderr: "pipe",
  });
  let captured;
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
    assert.equal(tools.length, 15); assert.deepEqual(captured, baseline);
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
  } finally { await client.close(); }
  const result = { status: "PASS", platform: process.platform, node: process.version, tgz,
    sha256: createHash("sha256").update(await fs.readFile(tgz)).digest("hex"), files: paths,
    privateSentinelsExcluded: privatePaths, installedBytesEqual: true, lockedDependenciesEqual: true,
    schemaDeepEqual: true, launcher: shim, nativeCmdWrapper: process.platform === "win32", tools: captured.tools.length };
  await fs.writeFile(join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, evidence: keep ? root : "temporary artifacts removed" }, null, 2));
} finally {
  if (!keep) await fs.rm(root, { recursive: true, force: true });
}
