import { constants } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { isId, newId } from "../core/ids.js";
import { isPathWithin, isWorkspaceRoot } from "../workspaces/workspace-paths.js";
import {
  createValidationRun, parseValidationRun, proposalFingerprint, transitionValidationRun,
  VALIDATION_RUN_TAIL_BYTES, ValidationRunError,
  type ValidationRun, type ValidationRunAdmission, type ValidationRunEvent
} from "./validation-run.js";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 4096;
type Identity = { dev: number; ino: number };
type StoreOptions = {
  maxStoreBytes?: number;
  protectedRoots?: readonly string[];
  onPersistenceFailure?: (error: ValidationRunStoreError) => void;
};

export class ValidationRunStoreError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ValidationRunStoreError"; }
}
function failure(code = "VALIDATION_STORE_UNAVAILABLE"): ValidationRunStoreError {
  return new ValidationRunStoreError(code);
}
function classified(error: unknown): Error {
  return error instanceof ValidationRunError || error instanceof ValidationRunStoreError ? error : failure();
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function sameIdentity(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Dedicated retained data only. The caller must provide one live writer and a trusted,
 * canonical directory outside every registered workspace. No owner handoff, execution,
 * automatic recovery or deletion occurs here. Reads observe immutable committed snapshots. */
export class ValidationRunStore {
  private readonly records = new Map<string, ValidationRun>();
  private readonly errors = new Map<string, Error>();
  private readonly keys = new Map<string, ValidationRun>();
  private readonly uncertain = new Set<string>();
  private readonly maxStoreBytes: number;
  private readonly protectedRoots: readonly string[];
  private readonly onPersistenceFailure: StoreOptions["onPersistenceFailure"];
  private identity: Identity | undefined;
  private loaded: Promise<void> | undefined;
  private mutation: Promise<unknown> = Promise.resolve();
  private writesBlocked = false;
  private indexIncomplete = false;
  private sequence = 0;

  constructor(private readonly directory: string, options: StoreOptions = {}) {
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES;
    this.protectedRoots = [...options.protectedRoots ?? []];
    this.onPersistenceFailure = options.onPersistenceFailure;
  }

  async get(id: string): Promise<ValidationRun | undefined> {
    if (!isId(id)) throw new ValidationRunError("VALIDATION_RUN_INVALID_INPUT");
    await this.load();
    await this.checkDirectory();
    if (this.uncertain.has(id)) throw failure();
    const error = this.errors.get(id);
    if (error) throw error;
    return this.records.get(id);
  }

  /** Startup recovery only; no mutation or execution is triggered by this read. */
  async retainedRuns(): Promise<readonly ValidationRun[]> {
    await this.load();
    await this.checkDirectory();
    if (this.indexIncomplete || this.errors.size || this.uncertain.size) throw failure();
    return [...this.records.values()].sort((a, b) => a.admission_sequence - b.admission_sequence);
  }

  async latest(patchId: string): Promise<ValidationRun | undefined> {
    await this.load();
    await this.checkDirectory();
    // An unreadable record might be newer and belong to this patch.
    if (this.indexIncomplete || this.errors.size || this.uncertain.size) throw failure();
    return [...this.records.values()].filter((run) => run.patch_task_id === patchId)
      .sort((a, b) => b.admission_sequence - a.admission_sequence)[0];
  }

  /** Call before resolving a live proposal/profile: a retry must survive their removal. */
  async replay(key: string, patchId: string): Promise<ValidationRun | undefined> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(key) || !patchId) throw new ValidationRunError("VALIDATION_RUN_INVALID_INPUT");
    await this.load();
    await this.checkDirectory();
    if (this.indexIncomplete || this.errors.size || this.uncertain.size) throw failure();
    const run = this.keys.get(key);
    if (run && run.patch_task_id !== patchId) throw failure("VALIDATION_IDEMPOTENCY_CONFLICT");
    return run;
  }

  async admit(input: ValidationRunAdmission): Promise<ValidationRun> {
    const captured = structuredClone(input);
    return this.serialize(async () => {
      await this.load();
      await this.checkDirectory();
      this.requireWritable();
      const existing = this.keys.get(captured.idempotency_key);
      if (existing) {
        if (existing.patch_task_id !== captured.patch_task_id ||
            existing.proposal_fingerprint !== proposalFingerprint(captured)) {
          throw failure("VALIDATION_IDEMPOTENCY_CONFLICT");
        }
        // A retry remains bound to the first snapshot even after CONFIGURE replacement.
        return existing;
      }
      await this.checkBoundary(captured.workspace_root);
      for (const run of this.records.values()) {
        if (run.patch_task_id !== captured.patch_task_id) continue;
        if (run.state === "running") throw failure("VALIDATION_ALREADY_RUNNING");
        if (run.cleanup.recovery_required || ["pending", "failed"].includes(run.cleanup.state)) {
          throw failure("VALIDATION_RECOVERY_REQUIRED");
        }
      }
      const run = createValidationRun(captured, {
        validation_run_id: newId(), admission_sequence: this.sequence + 1,
        admitted_at: new Date().toISOString()
      });
      const steps = [...run.profile_snapshot?.preparation ?? [], ...run.profile_snapshot?.validation ?? []];
      // Reserve encoded (not raw) tails and metadata before accepting any execution.
      const reserve = Buffer.byteLength(JSON.stringify(run)) +
        (steps.length + 1) * (6 * VALIDATION_RUN_TAIL_BYTES + 4096) +
        steps.reduce((bytes, step) => bytes + 2 * Buffer.byteLength(JSON.stringify(step.name)), 0) + 128 * 1024;
      if (reserve > MAX_RECORD_BYTES) throw failure("VALIDATION_STORE_FULL");
      await this.ensureDirectory();
      await this.checkCapacity(this.records.size + 1);
      await this.persist(run);
      this.publish(run);
      return run;
    });
  }

  async update(id: string, sequence: number, event: ValidationRunEvent): Promise<ValidationRun> {
    const captured = structuredClone(event);
    return this.serialize(async () => {
      const previous = await this.get(id);
      this.requireWritable();
      if (!previous) throw failure("VALIDATION_RUN_UNKNOWN");
      if (previous.operation_sequence !== sequence) throw failure("VALIDATION_STALE_UPDATE");
      const next = transitionValidationRun(previous, captured);
      await this.checkCapacity(this.records.size);
      await this.persist(next);
      this.publish(next);
      return next;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(operation).catch((error: unknown) => { throw classified(error); });
    this.mutation = pending.catch(() => undefined);
    return pending;
  }
  private requireWritable(): void {
    if (this.writesBlocked || this.errors.size) throw failure();
  }
  private publish(run: ValidationRun): void {
    this.records.set(run.validation_run_id, run);
    this.keys.set(run.idempotency_key, run);
    this.sequence = Math.max(this.sequence, run.admission_sequence);
  }
  private load(): Promise<void> {
    return this.loaded ??= this.reload().catch((error: unknown) => { throw classified(error); });
  }

  private async checkBoundary(workspaceRoot?: string): Promise<void> {
    if (!isWorkspaceRoot(this.directory) || this.directory.includes("\0") ||
        !Number.isSafeInteger(this.maxStoreBytes) || this.maxStoreBytes < 2 * MAX_RECORD_BYTES) {
      throw failure("VALIDATION_STORE_BOUNDARY");
    }
    const roots = workspaceRoot === undefined ? this.protectedRoots : [...this.protectedRoots, workspaceRoot];
    for (const root of roots) {
      if (!isWorkspaceRoot(root) || isPathWithin(root, this.directory)) throw failure("VALIDATION_STORE_BOUNDARY");
      // Historical queries use the configured canonical boundary; only new admission
      // needs a live workspace check. A deleted project must not hide retained history.
      if (workspaceRoot === undefined) continue;
      try {
        if (isPathWithin(await fs.realpath(root), this.directory)) throw failure("VALIDATION_STORE_BOUNDARY");
      } catch (error) {
        if (!missing(error)) throw error;
        // No canonicalization fallback for a configured protection boundary.
        throw failure("VALIDATION_STORE_BOUNDARY");
      }
    }
    let current = this.directory;
    while (true) {
      try {
        const stat = await fs.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("VALIDATION_STORE_BOUNDARY");
        if (current === this.directory && process.platform !== "win32" &&
            ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) {
          throw failure("VALIDATION_STORE_BOUNDARY");
        }
      } catch (error) {
        if (current !== this.directory || !missing(error)) throw failure("VALIDATION_STORE_BOUNDARY");
      }
      try {
        await fs.lstat(join(current, ".git"));
        throw failure("VALIDATION_STORE_BOUNDARY");
      } catch (error) { if (!missing(error)) throw failure("VALIDATION_STORE_BOUNDARY"); }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  private async checkDirectory(): Promise<void> {
    await this.checkBoundary();
    try {
      const stat = await fs.lstat(this.directory);
      if (this.identity && !sameIdentity(this.identity, stat)) throw failure("VALIDATION_STORE_BOUNDARY");
      if (!this.identity) throw failure("VALIDATION_STORE_BOUNDARY");
    } catch (error) {
      if (!this.identity && missing(error)) return;
      if (missing(error)) throw failure("VALIDATION_STORE_BOUNDARY");
      throw classified(error);
    }
  }
  private async ensureDirectory(): Promise<void> {
    if (this.identity) return;
    try {
      await fs.mkdir(this.directory, { mode: 0o700 });
      this.identity = await fs.lstat(this.directory);
      await this.syncDirectory(dirname(this.directory));
    } catch {
      this.writesBlocked = true;
      throw failure();
    }
  }

  private async reload(): Promise<void> {
    await this.checkBoundary();
    try { this.identity = await fs.lstat(this.directory); }
    catch (error) { if (missing(error)) return; throw failure(); }
    const sequences = new Map<number, string>();
    for (const name of await this.entries()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isId(id)) { this.writesBlocked = true; this.indexIncomplete = true; continue; }
      try {
        const run = await this.readRecord(join(this.directory, name));
        if (run.validation_run_id !== id) throw new ValidationRunError("VALIDATION_RUN_CORRUPT");
        const previous = this.keys.get(run.idempotency_key)?.validation_run_id ?? sequences.get(run.admission_sequence);
        if (previous) {
          this.errors.set(previous, new ValidationRunError("VALIDATION_RUN_CORRUPT"));
          throw new ValidationRunError("VALIDATION_RUN_CORRUPT");
        }
        sequences.set(run.admission_sequence, id);
        this.publish(run);
      } catch (error) {
        this.errors.set(id, error instanceof ValidationRunError ? error : failure());
      }
    }
  }

  private async entries(): Promise<string[]> {
    const names: string[] = [];
    const directory = await fs.opendir(this.directory);
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > MAX_ENTRIES) throw failure("VALIDATION_STORE_FULL");
    }
    return names;
  }
  private async checkCapacity(count: number): Promise<void> {
    let extraBytes = 0;
    for (const name of await this.entries()) {
      if (name.endsWith(".json") && this.records.has(name.slice(0, -5))) continue;
      const stat = await fs.lstat(join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure("VALIDATION_STORE_BOUNDARY");
      extraBytes += stat.size;
    }
    // One full replacement is reserved: mutations are serialized, execution is not.
    if ((count + 1) * MAX_RECORD_BYTES + extraBytes > this.maxStoreBytes) throw failure("VALIDATION_STORE_FULL");
  }

  private async readRecord(filename: string): Promise<ValidationRun> {
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES) throw new ValidationRunError("VALIDATION_RUN_CORRUPT");
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameIdentity(before, opened)) throw new ValidationRunError("VALIDATION_RUN_CORRUPT");
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_RECORD_BYTES) throw new ValidationRunError("VALIDATION_RUN_CORRUPT");
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
      catch { throw new ValidationRunError("VALIDATION_RUN_CORRUPT"); }
      return parseValidationRun(value);
    } finally { await handle.close(); }
  }

  private async syncDirectory(directory: string, onFailure?: () => void): Promise<void> {
    // Windows does not expose a portable directory fsync; file sync + rename still apply.
    if (process.platform === "win32") return;
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); }
    catch (error) { onFailure?.(); throw error; }
    finally { await handle.close(); }
  }
  private async persist(run: ValidationRun): Promise<void> {
    const contents = JSON.stringify(run);
    if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) throw failure("VALIDATION_STORE_FULL");
    const temporary = join(this.directory, `.${run.validation_run_id}.${newId()}.tmp`);
    let created = false;
    let renameAttempted = false;
    let writeFailure: ValidationRunStoreError | undefined;
    const reportFailure = (): ValidationRunStoreError => {
      if (!writeFailure) {
        this.writesBlocked = true;
        if (renameAttempted) this.uncertain.add(run.validation_run_id);
        writeFailure = failure();
        // Stop live execution before any error-path close or temporary cleanup.
        // The original persistence promise still owns and awaits all that I/O.
        this.onPersistenceFailure?.(writeFailure);
      }
      return writeFailure;
    };
    try {
      await this.checkDirectory();
      const handle = await fs.open(temporary, "wx", 0o600);
      created = true;
      try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
      catch { throw reportFailure(); }
      finally { await handle.close(); }
      await this.checkDirectory();
      renameAttempted = true;
      await fs.rename(temporary, join(this.directory, `${run.validation_run_id}.json`));
      await this.syncDirectory(this.directory, reportFailure);
    } catch {
      const error = reportFailure();
      if (created) {
        // A replaced directory is not ours to clean, even when its name is unchanged.
        await this.checkDirectory().then(() => fs.unlink(temporary)).catch(() => undefined);
      }
      throw error;
    }
  }
}
