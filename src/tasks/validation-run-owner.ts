import { constants } from "node:fs";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { newId } from "../core/ids.js";

const ownerSchema = z.object({
  schema_version: z.literal(1), instance_id: z.string().uuid(),
  pid: z.number().int().positive(), host: z.string(), platform: z.string(),
  uid: z.number().int().nonnegative().nullable(),
}).strict();
type OwnerRecord = z.infer<typeof ownerSchema>;
type Identity = { dev: bigint; ino: bigint };
function unavailable(): Error & { code: string } {
  return Object.assign(new Error("VALIDATION_OWNER_UNAVAILABLE"), { code: "VALIDATION_OWNER_UNAVAILABLE" });
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function same(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino; }

async function sync(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function checkDirectory(directory: string, privateMode = true): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0") || await fs.realpath(directory) !== directory) throw unavailable();
  for (let current = directory; ; current = dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    if (privateMode && current === directory && process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) throw unavailable();
    try { await fs.lstat(join(current, ".git")); throw unavailable(); }
    catch (error) { if (!missing(error)) throw error; }
    if (dirname(current) === current) break;
  }
}
async function readOwner(filename: string): Promise<OwnerRecord | undefined> {
  let before;
  try { before = await fs.lstat(filename, { bigint: true }); }
  catch (error) { if (missing(error)) return; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4096n || constants.O_NOFOLLOW === undefined) throw unavailable();
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, await handle.stat({ bigint: true }))) throw unavailable();
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 4096 || !same(before, await fs.lstat(filename, { bigint: true }))) throw unavailable();
    return ownerSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
  } finally { await handle.close(); }
}
function ownerAbsent(owner: OwnerRecord): boolean {
  // PID is only a conservative liveness veto, never a signaling/cleanup authority.
  // Same-host validated token + exclusive handoff guard establish ownership.
  if (owner.host !== hostname() || owner.platform !== process.platform ||
      owner.uid !== (process.getuid?.() ?? null)) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** One local service owner; every acquisition/release uses the same non-expiring guard.
 * A crash during handoff leaves the guard for explicit local recovery, never TTL deletion. */
export class ValidationRunOwner {
  readonly instanceId: string;
  private readonly filename: string;
  private readonly guard: string;
  private constructor(private readonly directory: string, private readonly record: OwnerRecord, private readonly identity: Identity) {
    this.instanceId = record.instance_id;
    this.filename = directory + ".owner.json";
    this.guard = directory + ".owner-guard";
  }

  static async acquire(directory: string): Promise<ValidationRunOwner> {
    try {
      // Validate the existing parent before creating the dedicated private directory.
      if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0")) throw unavailable();
      await checkDirectory(dirname(directory), false);
      try { await fs.mkdir(directory, { mode: 0o700 }); await sync(dirname(directory)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await checkDirectory(directory);
      const owner = new ValidationRunOwner(directory, {
        schema_version: 1, instance_id: newId(), pid: process.pid, host: hostname(),
        platform: process.platform, uid: process.getuid?.() ?? null,
      }, await fs.lstat(directory, { bigint: true }));
      await owner.change(async () => {
        const previous = await readOwner(owner.filename);
        if (previous && !ownerAbsent(previous)) throw unavailable();
        return "acquire";
      });
      return owner;
    } catch { throw unavailable(); }
  }

  async release(): Promise<void> {
    try {
      await this.change(async () => {
        const current = await readOwner(this.filename);
        if (current?.instance_id !== this.instanceId) throw unavailable();
        return "release";
      });
    } catch { throw unavailable(); }
  }

  private async change(check: () => Promise<"acquire" | "release">): Promise<void> {
    await checkDirectory(this.directory);
    if (!same(this.identity, await fs.lstat(this.directory, { bigint: true }))) throw unavailable();
    await fs.mkdir(this.guard, { mode: 0o700 });
    const guardIdentity = await fs.lstat(this.guard, { bigint: true });
    let changing = false;
    let complete = false;
    try {
      await sync(dirname(this.guard));
      const action = await check();
      changing = true;
      if (action === "acquire") {
        const temporary = this.filename + "." + this.instanceId + ".tmp";
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(this.record)); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, this.filename);
      } else await fs.unlink(this.filename);
      await sync(dirname(this.filename));
      complete = true;
    } finally {
      // Ambiguous writes keep the guard; no contender may act on a stale observation.
      if ((!changing || complete) && same(guardIdentity, await fs.lstat(this.guard, { bigint: true }))) {
        await fs.rmdir(this.guard);
        await sync(dirname(this.guard));
      }
    }
  }
}
