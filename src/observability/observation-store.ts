import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isPathWithin } from "../workspaces/workspace-paths.js";
import { MAX_ENVELOPE_BYTES } from "./observation-publisher.js";

type Identity = { dev: number; ino: number };
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const sameIdentity = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;

/** One writer, supplied by the publisher. This store never owns execution state. */
export class ObservationStore {
  private directory: string | undefined;
  private identity: Identity | undefined;
  private disabled = false;

  constructor(
    private readonly configPath: string,
    private readonly protectedRoots: readonly string[],
  ) {}

  async write(encoded: string): Promise<void> {
    if (this.disabled) return;
    let temporary: string | undefined;
    let created = false;
    try {
      if (Buffer.byteLength(encoded, "utf8") > MAX_ENVELOPE_BYTES) return;
      const record = JSON.parse(encoded) as { kind?: unknown; record_id?: unknown };
      if (typeof record.kind !== "string" || typeof record.record_id !== "string") return;
      if (!this.directory) {
        const config = resolve(this.configPath);
        this.directory = join(await fs.realpath(dirname(config)), basename(config) + ".observations");
        await this.checkBoundary();
        try { await fs.mkdir(this.directory, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await this.checkBoundary();
        this.identity = await fs.lstat(this.directory);
      }
      await this.checkDirectory();
      // Hash both components rather than interpreting record identity as a path.
      const key = createHash("sha256").update(JSON.stringify([record.kind, record.record_id])).digest("hex");
      temporary = join(this.directory, "." + key + "." + randomUUID() + ".tmp");
      const handle = await fs.open(temporary, "wx", 0o600);
      created = true;
      try {
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.writeFile(encoded, "utf8");
      } finally { await handle.close(); }
      await this.checkDirectory();
      await fs.rename(temporary, join(this.directory, key + ".json"));
    } catch {
      // Disable this optional sink, without any canonical store's fatal callback.
      this.disabled = true;
    } finally {
      if (created && temporary) {
        try {
          await this.checkDirectory();
          await fs.unlink(temporary);
        } catch { /* Renamed, unavailable, or no longer our directory. */ }
      }
    }
  }

  private async checkBoundary(): Promise<void> {
    const directory = this.directory!;
    let directoryIdentity: Identity | undefined;
    try { directoryIdentity = await fs.lstat(directory); }
    catch (error) { if (!missing(error)) throw error; }
    const protectedIdentities: Identity[] = [];
    for (const root of this.protectedRoots) {
      // An unresolved boundary is unsafe; do not guess where it will be created.
      const canonical = await fs.realpath(root);
      if ([resolve(root), canonical].some(candidate =>
        isPathWithin(candidate, directory) || isPathWithin(directory, candidate))) {
        throw new Error("Observation boundary");
      }
      // Compare directory identities too: realpath spelling alone cannot exclude aliases.
      let ancestor = canonical;
      while (true) {
        const stat = await fs.stat(ancestor);
        if (!stat.isDirectory()) throw new Error("Observation boundary");
        if (ancestor === canonical) protectedIdentities.push(stat);
        if (directoryIdentity && sameIdentity(directoryIdentity, stat)) {
          throw new Error("Observation boundary");
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    let current = directory;
    while (true) {
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Observation boundary");
        if (protectedIdentities.some(identity => sameIdentity(identity, stat))) {
          throw new Error("Observation boundary");
        }
        if (current === directory && process.platform !== "win32" &&
            ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
          throw new Error("Observation permissions");
        }
      } catch (error) {
        if (current !== directory || !missing(error)) throw error;
      }
      // Refuse unregistered Git workspaces and canonical execution directories too.
      if (current !== directory && /\.(validation-runs|validation-worktrees)$/.test(basename(current))) {
        throw new Error("Observation execution boundary");
      }
      try {
        await fs.lstat(join(current, ".git"));
        throw new Error("Observation workspace boundary");
      } catch (error) { if (!missing(error)) throw error; }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private async checkDirectory(): Promise<void> {
    await this.checkBoundary();
    const stat = await fs.lstat(this.directory!);
    if (!this.identity || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      throw new Error("Observation directory replaced");
    }
  }
}
