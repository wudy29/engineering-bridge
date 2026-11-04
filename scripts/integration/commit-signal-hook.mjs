// Test-only fault coordination and phase observation. Never enabled by production.
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.BRIDGE_INTEGRATION_CASE, mode = process.env.BRIDGE_INTEGRATION_MODE;
const source = process.env.BRIDGE_CANDIDATE_ROOT;
const trace = (event, data = {}) => fs.appendFileSync(join(root, "events.jsonl"), JSON.stringify({ event, pid: process.pid, ms: String(process.hrtime.bigint() / 1000000n), ...data }) + "\n");
const ready = phase => { trace(phase); fs.writeFileSync(join(root, "ready"), phase); };
const hold = () => new Promise(resolve => {
  const timer = setInterval(() => { if (fs.existsSync(join(root, "release"))) { clearInterval(timer); resolve(); } }, 10);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => trace("signal_received", { signal }));
const originalSpawn = cp.spawn;
const ownedGroups = [];
let lastIndexHash;
cp.spawn = function(executable, args, options) {
  const publisher = executable === "git" && args.includes("update-ref");
  const privateInput = executable === "git" && mode === "private-index-unknown" && args.includes("apply") && args.includes("--cached");
  const proxy = publisher && ["held-commit", "exit-error-after-publish", "publisher-timeout", "publisher-unknown", "closed-parent-descendant"].includes(mode);
  let child;
  if (proxy || privateInput) {
    const { NODE_OPTIONS, ...env } = { ...process.env, ...options.env };
    child = originalSpawn(process.execPath, [process.env.BRIDGE_INTEGRATION_PROXY, privateInput ? "held-input" : mode, root, ...args], { ...options, env });
  } else child = originalSpawn(executable, args, options);
  if (publisher || privateInput) ownedGroups.push(child.pid);
  if (executable === "git") {
    trace(publisher ? "publisher_spawn" : "git_spawn", { childPid: child.pid, args });
    child.once("exit", (code, signal) => trace(publisher ? "publisher_exit" : "git_exit", { childPid: child.pid, code, signal }));
    child.once("close", (code, signal) => {
      trace(publisher ? "publisher_close" : "git_close", { childPid: child.pid, code, signal });
      if (fs.existsSync(join(root, "repo/.git/index"))) {
        const digest = createHash("sha256").update(fs.readFileSync(join(root, "repo/.git/index"))).digest("hex");
        if (digest !== lastIndexHash) trace("shared_index_changed", { args, sha256: digest });
        lastIndexHash = digest;
      }
    });
  }
  return child;
};
const rename = fsp.rename;
fsp.rename = async function(from, to) {
  const indexInstall = String(from) === join(root, "repo/.git/index.lock") && String(to) === join(root, "repo/.git/index");
  if (indexInstall) {
    const bytes = await fsp.readFile(from); await fsp.writeFile(join(root, "index-install-input"), bytes);
    trace("index_install_enter", { sha256: createHash("sha256").update(bytes).digest("hex") });
    if (["before-index-install", "index-install-error"].includes(mode)) { ready("published_before_index_install"); await hold(); }
    if (mode === "index-install-error") throw Object.assign(new Error("fixture index install denied"), { code: "EACCES" });
  }
  const result = await rename(from, to);
  if (indexInstall) {
    const bytes = await fsp.readFile(to); await fsp.writeFile(join(root, "index-installed"), bytes);
    trace("index_installed", { sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return result;
};
syncBuiltinESMExports();
const { ControlledPatchService } = await import(pathToFileURL(join(source, "dist/src/tasks/controlled-patch-service.js")));
const shutdown = ControlledPatchService.prototype.shutdown;
if (shutdown) ControlledPatchService.prototype.shutdown = function() {
  const result = shutdown.call(this);
  trace("shutdown_started", { closing: this.closing });
  fs.writeFileSync(join(root, "shutdown-started"), "closed admission");
  result.then(() => trace("writes_drained"), () => { trace("shutdown_failed"); fs.writeFileSync(join(root, "shutdown-failed"), "unconfirmed"); });
  return result;
};
const commit = ControlledPatchService.prototype.commit;
ControlledPatchService.prototype.commit = function(request) {
  if (["publisher-timeout", "publisher-unknown", "private-index-unknown"].includes(mode)) {
    this.gitProcessOptions = { ...this.gitProcessOptions, timing: { executionTimeoutMs: 1000, killGraceMs: 100 },
      ...(["publisher-unknown", "private-index-unknown"].includes(mode) ? { signaler: (_child, _platform, signal) => trace("signal_delivery_denied", { signal }) } : {}) };
  }
  trace("commit_request");
  return commit.call(this, request).then(value => { trace("commit_result", { ok: true, oid: value.commit_sha }); return value; }, error => {
    trace("commit_result", { ok: false, code: error.code, message: error.message }); throw error;
  });
};
const queue = ControlledPatchService.prototype.withApplyLock;
ControlledPatchService.prototype.withApplyLock = function(...args) {
  const result = queue.apply(this, args); trace("write_enqueued"); return result;
};
const { ControlledCommitIndex } = await import(pathToFileURL(join(source, "dist/src/tasks/controlled-commit-index.js")));
const publish = ControlledCommitIndex.prototype.publish;
ControlledCommitIndex.prototype.publish = function(tree, base, message, verify) {
  trace("publish_enter", { tree, base });
  return publish.call(this, tree, base, message, async () => {
    await verify(); trace("prepared_verified");
    if (mode === "before-publish") { ready("before_publish"); await hold(); }
  });
};
process.on("exit", code => {
  if (fs.existsSync(join(root, "repo/.git/index"))) fs.copyFileSync(join(root, "repo/.git/index"), join(root, "index-at-bridge-exit"));
  trace("bridge_exit", { code, groups: ownedGroups.map(pid => {
  let gone = false;
  try { process.kill(-pid, 0); } catch (error) { gone = error.code === "ESRCH"; }
  return { pid, gone };
}) }); });
