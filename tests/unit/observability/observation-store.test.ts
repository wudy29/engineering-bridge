import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { ObservationStore } from "../../../src/observability/observation-store.js";

const encoded = (sequence: number, metadata = { pid: 123 }): string => JSON.stringify({
  schema_version: 1, producer_id: "producer", kind: "producer", record_id: "producer",
  sequence, observed_at: "2026-09-20T00:00:00.000Z", metadata,
});
const filename = createHash("sha256").update(JSON.stringify(["producer", "producer"])).digest("hex") + ".json";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-observation-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = join(root, "workspaces.json");
  const directory = config + ".observations";
  return { root, config, directory, store: new ObservationStore(config, []) };
}

test("store replaces complete JSON through a private same-directory temporary file", async t => {
  const f = await fixture(t);
  await f.store.write(encoded(1));
  const target = join(f.directory, filename);
  const rename = fs.rename;
  let replacements = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    assert.equal(dirname(String(args[0])), f.directory);
    assert.equal(String(args[1]), target);
    assert.equal(await fs.readFile(target, "utf8"), encoded(1));
    assert.equal(await fs.readFile(args[0], "utf8"), encoded(2, { pid: 456 }));
    replacements++;
    await rename(...args);
  });
  await f.store.write(encoded(2, { pid: 456 }));
  assert.equal(replacements, 1);
  assert.equal(await fs.readFile(target, "utf8"), encoded(2, { pid: 456 }));
  assert.deepEqual(await fs.readdir(f.directory), [filename]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  }
});

test("rename failure preserves the old record, removes the temp, and disables further writes", async t => {
  const f = await fixture(t);
  await f.store.write(encoded(1));
  let attempts = 0;
  t.mock.method(fs, "rename", async () => { attempts++; throw new Error("injected I/O failure"); });
  await assert.doesNotReject(f.store.write(encoded(2)));
  await assert.doesNotReject(f.store.write(encoded(3)));
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(join(f.directory, filename), "utf8"), encoded(1));
  assert.deepEqual(await fs.readdir(f.directory), [filename]);
});

for (const boundary of ["registered", "git", "execution", "unresolved"] as const) {
  test("unsafe " + boundary + " location disables observation without creating storage", async t => {
    const f = await fixture(t);
    let config = f.config;
    let roots: string[] = [];
    if (boundary === "registered") roots = [f.root];
    if (boundary === "git") await fs.writeFile(join(f.root, ".git"), "gitdir: elsewhere");
    if (boundary === "execution") {
      const execution = join(f.root, "other.json.validation-runs");
      await fs.mkdir(execution);
      config = join(execution, "workspaces.json");
    }
    if (boundary === "unresolved") roots = [join(f.root, "missing")];
    await assert.doesNotReject(new ObservationStore(config, roots).write(encoded(1)));
    await assert.rejects(fs.stat(config + ".observations"), { code: "ENOENT" });
  });
}

test("symlink directory and protected-root aliases cannot redirect observation", {
  skip: process.platform === "win32",
}, async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, f.directory);
  await f.store.write(encoded(1));
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.directory);
  const alias = join(f.root, "alias");
  await fs.symlink(f.root, alias);
  await new ObservationStore(f.config, [alias]).write(encoded(1));
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("a replaced observation directory is neither written nor cleaned", async t => {
  const f = await fixture(t);
  await f.store.write(encoded(1));
  await fs.rename(f.directory, f.directory + ".old");
  await fs.mkdir(f.directory, { mode: 0o700 });
  await fs.writeFile(join(f.directory, "sentinel"), "keep");
  await f.store.write(encoded(2));
  assert.deepEqual(await fs.readdir(f.directory), ["sentinel"]);
  assert.equal(await fs.readFile(join(f.directory + ".old", filename), "utf8"), encoded(1));
});

test("a protected descendant prevents writes to an existing observation directory", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { mode: 0o700 });
  const descendant = join(f.directory, "workspace");
  await fs.mkdir(descendant);
  await fs.writeFile(join(descendant, "sentinel"), "keep");
  const store = new ObservationStore(f.config, [descendant]);
  await assert.doesNotReject(store.write(encoded(1)));
  await assert.doesNotReject(store.write(encoded(2)));
  assert.deepEqual(await fs.readdir(f.directory), ["workspace"]);
  assert.deepEqual(await fs.readdir(descendant), ["sentinel"]);
  assert.equal(await fs.readFile(join(descendant, "sentinel"), "utf8"), "keep");
});

for (const overlap of ["same", "ancestor", "descendant"] as const) {
  test("filesystem identity rejects case-equivalent protected " + overlap + " paths", async t => {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { mode: 0o700 });
    const alias = join(f.root, "WORKSPACES.JSON.OBSERVATIONS");
    let aliasStat;
    try { aliasStat = await fs.stat(alias); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      t.skip("fixture filesystem does not support this case-equivalent alias");
      return;
    }
    const original = await fs.stat(f.directory);
    assert.equal(aliasStat.dev, original.dev);
    assert.equal(aliasStat.ino, original.ino);
    const nested = join(f.directory, "workspace");
    await fs.mkdir(nested);
    await fs.writeFile(join(nested, "sentinel"), "keep");
    const protectedRoot = overlap === "descendant" ? join(alias, "workspace") : alias;
    const config = overlap === "ancestor" ? join(nested, "workspaces.json") : f.config;
    const realpath = fs.realpath;
    // Keep a valid alternate spelling so identity, not realpath normalization, is exercised.
    t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) =>
      String(args[0]) === protectedRoot ? protectedRoot : realpath(...args));
    const store = new ObservationStore(config, [protectedRoot]);
    await assert.doesNotReject(store.write(encoded(1)));
    await assert.doesNotReject(store.write(encoded(2)));
    assert.deepEqual(await fs.readdir(f.directory), ["workspace"]);
    assert.deepEqual(await fs.readdir(nested), ["sentinel"]);
    assert.equal(await fs.readFile(join(nested, "sentinel"), "utf8"), "keep");
  });
}
