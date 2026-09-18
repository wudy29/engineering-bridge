import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";

const moduleUrl = new URL("../../../src/tasks/validation-run-owner.js", import.meta.url);
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
async function ownerType() {
  const module = await import(moduleUrl.href).catch(() => undefined);
  assert.equal(typeof module?.ValidationRunOwner?.acquire, "function", "single service owner handoff is implemented");
  return module.ValidationRunOwner;
}
async function fixture(t: any) {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-run-owner-")));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "runs");
  await fs.mkdir(directory, { mode: 0o700 });
  return { parent, directory };
}
test("two owners contend for the same guard and only one can own the store", async (t) => {
  const Owner = await ownerType();
  const { directory } = await fixture(t);
  const attempts = await Promise.allSettled([Owner.acquire(directory), Owner.acquire(directory)]);
  const winners = attempts.filter((x): x is PromiseFulfilledResult<any> => x.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter(x => x.status === "rejected").length, 1);
  await assert.rejects(Owner.acquire(directory), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  await winners[0]!.value.release();
  const next = await Owner.acquire(directory);
  assert.notEqual(next.instanceId, winners[0]!.value.instanceId);
  await next.release();
});
test("an ordinary trusted parent can contain the dedicated private owned directory", async t => {
  const Owner = await ownerType();
  const { parent, directory } = await fixture(t);
  await fs.chmod(parent, 0o755);
  const owner = await Owner.acquire(directory);
  assert.equal((await fs.stat(directory)).mode & 0o077, 0);
  await owner.release();
});
test("a trailing directory separator cannot acquire a second owner of the same inode", async t => {
  const Owner = await ownerType();
  const { directory } = await fixture(t);
  const first = await Owner.acquire(directory);
  await assert.rejects(Owner.acquire(directory + "/"), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  assert.deepEqual(await fs.readdir(directory), []);
  await first.release();
});
test("stale handoff guard is never expired, removed or used to infer dead ownership", async (t) => {
  const Owner = await ownerType();
  const { directory } = await fixture(t);
  await fs.mkdir(directory + ".owner-guard");
  await assert.rejects(Owner.acquire(directory), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  assert.equal((await fs.stat(directory + ".owner-guard")).isDirectory(), true);
});
test("ambiguous owner replacement keeps its non-expiring handoff guard", async t => {
  const Owner = await ownerType();
  const { directory } = await fixture(t);
  const rename = fs.rename.bind(fs);
  const fail = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); throw Error("crash after owner rename before durability acknowledgement");
  });
  await assert.rejects(Owner.acquire(directory), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  fail.mock.restore();
  assert.equal((await fs.stat(directory + ".owner-guard")).isDirectory(), true);
  const before = await fs.readFile(directory + ".owner.json", "utf8");
  await assert.rejects(Owner.acquire(directory), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  assert.equal(await fs.readFile(directory + ".owner.json", "utf8"), before);
});
test("corrupt owner and substituted directory fail closed without changing their bytes", async (t) => {
  const Owner = await ownerType();
  const { parent, directory } = await fixture(t);
  await fs.writeFile(directory + ".owner.json", "corrupt\n", { mode: 0o600 });
  await assert.rejects(Owner.acquire(directory), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  assert.equal(await fs.readFile(directory + ".owner.json", "utf8"), "corrupt\n");
  const alias = join(parent, "alias");
  await fs.symlink(directory, alias);
  await assert.rejects(Owner.acquire(alias), { code: "VALIDATION_OWNER_UNAVAILABLE" });
});
test("old token cannot release a replacement owner, even when PID is the same", async (t) => {
  const Owner = await ownerType();
  const { directory } = await fixture(t);
  const first = await Owner.acquire(directory);
  const filename = directory + ".owner.json";
  const record = JSON.parse(await fs.readFile(filename, "utf8"));
  record.instance_id = "00000000-0000-4000-8000-000000000077";
  await fs.writeFile(filename, JSON.stringify(record));
  await assert.rejects(first.release(), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).instance_id, record.instance_id);
});
test("two processes racing after owner death cannot both take over; no old process is attached", async (t) => {
  const Owner = await ownerType();
  const { parent, directory } = await fixture(t);
  const worker = join(parent, "owner-worker.mjs");
  await fs.writeFile(worker, [
    "import { ValidationRunOwner } from " + JSON.stringify(moduleUrl.href) + ";",
    "try { const owner = await ValidationRunOwner.acquire(process.argv[2]); process.send({ok:true,id:owner.instanceId}); setInterval(()=>{},1000); }",
    "catch(error) { process.send({ok:false,code:error.code}); process.exitCode=1; }"
  ].join("\n"));
  const children: ReturnType<typeof fork>[] = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; } });
  const start = () => { const child = fork(worker, [directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child); return child; };
  const first = start();
  assert.equal((await once(first, "message"))[0].ok, true);
  const exited = once(first, "exit"); first.kill("SIGKILL"); await exited;
  const contenders = [start(), start()];
  const replies = await Promise.all(contenders.map(async child => (await once(child, "message"))[0]));
  assert.equal(replies.filter(x => x.ok).length, 1);
  assert.equal(replies.filter(x => x.code === "VALIDATION_OWNER_UNAVAILABLE").length, 1);
  await assert.rejects(Owner.acquire(directory), { code: "VALIDATION_OWNER_UNAVAILABLE" });
});
