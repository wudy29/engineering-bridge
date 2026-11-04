// CI-only log collector. It records and returns the real command exit status.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const [name, executable, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/u.test(name ?? "") || !executable) throw new Error("name and command required");
const root = process.env.BRIDGE_CI_EVIDENCE ?? "integration-evidence";
fs.mkdirSync(root, { recursive: true });
const log = fs.openSync(join(root, name + ".log"), "w"), started = new Date().toISOString();
const child = spawn(executable, args, { stdio: ["ignore", log, log], shell: false });
child.once("error", error => fs.writeSync(log, String(error) + "\n"));
child.once("close", (code, signal) => {
  fs.closeSync(log);
  const result = { command: [executable, ...args], started, ended: new Date().toISOString(), code, signal };
  fs.writeFileSync(join(root, name + "-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ name, ...result }));
  process.stdout.write(fs.readFileSync(join(root, name + ".log")));
  process.exitCode = code ?? 1;
});
