// A real Git process; only its explicit input/exit fault window is controlled.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const [mode, root, ...args] = process.argv.slice(2);
const trace = (event, data = {}) => fs.appendFileSync(join(root, "events.jsonl"), JSON.stringify({ event, pid: process.pid, ms: String(process.hrtime.bigint() / 1000000n), ...data }) + "\n");
process.stdout.on("error", error => trace("publisher_output_closed", { code: error.code }));
const child = spawn("git", args, { stdio: "pipe" });
trace("native_git_spawn", { childPid: child.pid });
child.stdout.on("data", data => { trace("native_git_stdout", { text: String(data) }); process.stdout.write(data); });
child.stderr.pipe(process.stderr);
child.stdin.on("error", error => trace("native_git_stdin_error", { code: error.code }));
child.on("close", async (code, signal) => {
  trace("native_git_close", { code, signal });
  if (mode === "closed-parent-descendant" && code === 0) {
    const code = `const fs=require('node:fs');process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "release-children"))}))process.exit(0)},10)`;
    const descendant = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await new Promise(resolve => descendant.once("message", resolve)); descendant.disconnect();
    trace("owned_descendant", { childPid: descendant.pid }); fs.writeFileSync(join(root, "ready"), "owned_descendant");
  }
  process.exit(mode === "exit-error-after-publish" ? 7 : code ?? 1);
});
let input = "", held = false;
const waitRelease = publish => {
  held = true; trace("commit_received_not_forwarded"); fs.writeFileSync(join(root, "ready"), "commit_received_not_forwarded");
  const timer = setInterval(() => { if (fs.existsSync(join(root, "release"))) {
    clearInterval(timer); trace(mode === "held-input" ? "private_input_forwarded" : "commit_forwarded"); child.stdin.end(publish);
  } }, 10);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (mode === "held-input") return;
  while (input.includes("\n")) {
    const index = input.indexOf("\n"), line = input.slice(0, index); input = input.slice(index + 1);
    if (line === "commit" && ["held-commit", "publisher-timeout", "publisher-unknown"].includes(mode)) waitRelease("commit\n");
    else child.stdin.write(line + "\n");
  }
});
process.stdin.on("end", () => {
  trace("bridge_stdin_eof");
  if (mode === "held-input") waitRelease(input);
  else if (!held) child.stdin.end();
});
