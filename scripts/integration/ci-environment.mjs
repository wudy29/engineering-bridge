// CI metadata only: never dump the environment or provide CLI/publishing credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve(process.env.BRIDGE_CI_EVIDENCE);
fs.mkdirSync(root, { recursive: true });
assert.equal(process.platform, process.env.BRIDGE_EXPECTED_PLATFORM);
assert.equal(process.versions.node.split(".")[0], process.env.BRIDGE_EXPECTED_NODE);
const run = (file, args) => execFileSync(file, args, { encoding: "utf8" }).trim();
const npm = run(process.platform === "win32" ? "where" : "which", ["npm"]).split(/\r?\n/u)[0];
const cli = path.join(path.dirname(fs.realpathSync(npm)), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm-cli.js");
assert.ok(fs.existsSync(cli), "npm CLI not resolved");
const metadata = {
  platform: process.platform, arch: process.arch, os: os.version(), release: os.release(),
  node: process.version, npm: run(process.execPath, [cli, "--version"]), git: run("git", ["--version"]),
  commit: run("git", ["rev-parse", "HEAD"]), tree: run("git", ["rev-parse", "HEAD^{tree}"]),
  runner: Object.fromEntries(["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REF", "GITHUB_SHA"].map(key => [key, process.env[key] ?? null])),
  cwd: process.cwd(), tmpdir: os.tmpdir(), diagnosticPreload: false,
};
if (process.platform === "win32") assert.match(metadata.git, /windows/iu, "actual Git for Windows required");
fs.writeFileSync(path.join(root, "environment.json"), JSON.stringify(metadata, null, 2) + "\n");
const empty = path.join(root, "empty-git-config"); fs.writeFileSync(empty, "");
fs.appendFileSync(process.env.GITHUB_ENV, `GIT_CONFIG_GLOBAL=${empty}\nGIT_CONFIG_NOSYSTEM=1\nBRIDGE_NPM_CLI=${cli}\n`);
console.log(JSON.stringify(metadata));
