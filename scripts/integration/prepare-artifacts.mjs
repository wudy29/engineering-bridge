// Only synthetic CI evidence is eligible. Inspect before copying into the upload directory.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { createHash } from "node:crypto";
const source = resolve(process.env.BRIDGE_CI_EVIDENCE), destination = resolve(process.env.BRIDGE_CI_UPLOAD);
assert.notEqual(source, destination);
await fs.mkdir(destination, { recursive: false });
const files = [], rejected = [], excluded = [];
const privateText = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{32,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\/Users\/mac\/|EngineeringBridge-Backups)/u;
async function inspect(directory, relative = "") {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = join(relative, entry.name), filename = join(directory, entry.name);
    if (["source", "consumer", "node_modules", ".git"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) { rejected.push({ path: name, reason: "symlink" }); continue; }
    if (entry.isDirectory()) { await inspect(filename, name); continue; }
    if (!entry.isFile() || ![".json", ".jsonl", ".log", ".txt", ".tgz"].includes(extname(name))) continue;
    if (/^(?:\.env|credentials|workspaces)\b/iu.test(entry.name)) { excluded.push({ path: name, reason: "configuration is not an upload artifact" }); continue; }
    const bytes = await fs.readFile(filename);
    if (name.endsWith(".tgz")) {
      const receipt = await fs.readFile(join(directory, "result.json"), "utf8").then(JSON.parse, () => null);
      if (!receipt || receipt.status !== "PASS" || receipt.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        excluded.push({ path: name, reason: "package has no successful verified receipt" }); continue;
      }
    } else if (privateText.test(bytes.toString("utf8"))) { rejected.push({ path: name, reason: "private content pattern" }); continue; }
    files.push({ source: filename, path: name, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}
await inspect(source);
// Do not print suspect content, and do not upload any artifact if inspection fails.
assert.equal(rejected.length, 0, JSON.stringify(rejected));
for (const file of files) {
  const output = join(destination, file.path);
  await fs.mkdir(resolve(output, ".."), { recursive: true }); await fs.copyFile(file.source, output);
}
await fs.writeFile(join(destination, "artifact-check.json"), JSON.stringify({
  status: "PASS", syntheticOnly: true, files: files.map(({ path, sha256 }) => ({ path, sha256 })), excluded,
}, null, 2) + "\n");
await fs.appendFile(process.env.GITHUB_OUTPUT, `upload_path=${destination}\n`);
console.log(`Inspected ${files.length} synthetic evidence files; ${excluded.length} ineligible entries excluded.`);
