// Bounded CI diagnosis only. Ordinary acceptance never imports this file.
// Questions: which mixed task misses readiness; why does an already-gone Windows
// descendant leave teardown waiting for its cooperative stopped marker?
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
assert.equal(process.env.BRIDGE_CI_DIAGNOSTIC, "1");
const output = join(resolve(process.env.BRIDGE_CI_EVIDENCE), "diagnostic");
fs.mkdirSync(output, { recursive: true });
const log = join(output, `process-${process.pid}.jsonl`);
const note = (event, data = {}) => fs.appendFileSync(log, JSON.stringify({
  event, pid: process.pid, ms: String(process.hrtime.bigint() / 1000000n), ...data,
}) + "\n");
note("start", { ppid: process.ppid, argv: process.argv, cwd: process.cwd() });
const spawn = cp.spawn;
cp.spawn = function (file, args, options) {
  const env = { ...(options?.env ?? process.env), BRIDGE_CI_DIAGNOSTIC: "1", BRIDGE_CI_EVIDENCE: process.env.BRIDGE_CI_EVIDENCE };
  const preload = `--import=${import.meta.url}`;
  if (!(env.NODE_OPTIONS ?? "").includes(preload)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} ${preload}`.trim();
  const child = spawn(file, args, { ...options, env });
  note("spawn", { childPid: child.pid, file, args, cwd: options?.cwd });
  child.on("error", error => note("spawn-error", { childPid: child.pid, code: error.code, message: error.message }));
  child.on("exit", (code, signal) => note("exit", { childPid: child.pid, code, signal }));
  child.on("close", (code, signal) => note("close", { childPid: child.pid, code, signal }));
  child.stdout?.on("data", data => note("stdout", { childPid: child.pid, text: data.toString() }));
  child.stderr?.on("data", data => note("stderr", { childPid: child.pid, text: data.toString() }));
  return child;
};
const kill = process.kill, seen = new Set();
process.kill = function (pid, signal) {
  const key = `${pid}:${signal}`;
  try {
    const result = kill(pid, signal);
    if (signal !== 0 || !seen.has(key + ":alive")) note("kill", { target: pid, signal, result });
    seen.add(key + ":alive"); return result;
  } catch (error) {
    if (signal !== 0 || !seen.has(key + ":" + error.code)) note("kill-error", { target: pid, signal, code: error.code });
    seen.add(key + ":" + error.code); throw error;
  }
};
const fixtureRoot = path => /^(bridge-commit-signal-|bridge-win-parent-exit-)/u.test(basename(path));
function snapshot(root, stage) {
  try {
  const files = {};
  for (const name of fs.readdirSync(root)) {
    const path = join(root, name);
    if (fs.statSync(path).isFile() && /\.jsonl?$|\.log$|^(release|release-children|stopped|dsh)$/u.test(name)) files[name] = fs.readFileSync(path, "utf8");
    if (name.endsWith(".validation-runs") && fs.statSync(path).isDirectory()) {
      for (const item of fs.readdirSync(path).filter(x => x.endsWith(".json"))) files[join(name, item)] = fs.readFileSync(join(path, item), "utf8");
    }
  }
  note("fixture-snapshot", { root, stage, files });
  } catch (error) { note("snapshot-error", { root, stage, code: error.code, message: error.message }); }
}
const writeFile = fsp.writeFile;
fsp.writeFile = async function (path, ...args) {
  if (typeof path === "string" && basename(path) === "release" && fixtureRoot(dirname(path))) snapshot(dirname(path), "before-teardown-release");
  return writeFile.call(this, path, ...args);
};
const rm = fsp.rm;
fsp.rm = async function (path, ...args) {
  if (typeof path === "string" && fixtureRoot(path)) snapshot(path, "after-teardown-before-removal");
  return rm.call(this, path, ...args);
};
syncBuiltinESMExports();
process.on("uncaughtExceptionMonitor", error => note("uncaught", { code: error.code, message: error.message }));
process.on("exit", code => note("process-exit", { code }));
