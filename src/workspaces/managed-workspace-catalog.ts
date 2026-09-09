import { readFile, rename, unlink, writeFile } from "node:fs/promises";

import { CoreError } from "../core/errors.js";
import { isId, newId } from "../core/ids.js";
import type { Id } from "../core/ids.js";
import { isWorkspaceRoot } from "./workspace-paths.js";

export interface ManagedWorkspaceRecord {
  readonly id: Id;
  readonly root: string;
  readonly allowWrite: boolean;
}

const MANAGED_WORKSPACES_VERSION = 1;

export class ManagedWorkspaceCatalog {
  private records = new Map<string, ManagedWorkspaceRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(private readonly stateFilePath?: string) {}

  async load(): Promise<void> {
    if (this.stateFilePath === undefined) return;
    if (this.records.size !== 0) throw new CoreError("INTERNAL_ERROR");
    let source: string;
    try {
      source = await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CoreError("INTERNAL_ERROR");
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new CoreError("INTERNAL_ERROR");
    }
    if (!isObject(value) || value.version !== MANAGED_WORKSPACES_VERSION ||
        !Array.isArray(value.workspaces)) {
      throw new CoreError("INTERNAL_ERROR");
    }

    for (const item of value.workspaces) {
      if (!isObject(item)) continue;
      const { id, root, allow_write } = item;
      if (typeof id !== "string" || !isId(id) ||
          !isWorkspaceRoot(root) ||
          (allow_write !== undefined && typeof allow_write !== "boolean")) {
        continue; // Skip individually invalid records.
      }
      if ([...this.records.values()].some((record) => record.id === id) ||
          this.records.has(root)) {
        continue; // Skip duplicate ids or roots.
      }
      // Records without allow_write are pre-authorization v1 entries: read-only.
      this.records.set(root, { id, root, allowWrite: allow_write ?? false });
    }
  }

  entries(): ManagedWorkspaceRecord[] {
    return [...this.records.values()];
  }

  registerOnce(root: string): Promise<{ id: Id; created: boolean }> {
    const mutation = this.mutationQueue.then(async (): Promise<{ id: Id; created: boolean }> => {
      if (!isWorkspaceRoot(root)) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      const existing = this.records.get(root);
      if (existing !== undefined) return { id: existing.id, created: false };
      const id = newId();
      const snapshot = this.records;
      this.records = new Map(snapshot);
      this.records.set(root, { id, root, allowWrite: false });
      try {
        await this.persist();
      } catch {
        this.records = snapshot;
        throw new CoreError("INTERNAL_ERROR");
      }
      return { id, created: true };
    });
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  // Grants persistent controlled-write authorization for one managed workspace.
  // Runs inside the same mutation queue as registration so concurrent calls are
  // serialized and idempotent; a persist failure rolls back the in-memory record.
  authorize(root: string): Promise<void> {
    const mutation = this.mutationQueue.then(async (): Promise<void> => {
      const record = this.records.get(root);
      if (record === undefined) throw new CoreError("INTERNAL_ERROR");
      if (record.allowWrite) return;
      const snapshot = this.records;
      this.records = new Map(snapshot);
      this.records.set(root, { ...record, allowWrite: true });
      try {
        await this.persist();
      } catch {
        this.records = snapshot;
        throw new CoreError("INTERNAL_ERROR");
      }
    });
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  private persist(): Promise<void> {
    if (this.stateFilePath === undefined) return Promise.resolve();
    const contents = `${JSON.stringify({
      version: MANAGED_WORKSPACES_VERSION,
      workspaces: [...this.records.values()].map(({ id, root, allowWrite }) => ({
        id,
        root,
        allow_write: allowWrite
      }))
    }, null, 2)}\n`;
    return this.writeStateFile(contents);
  }

  private async writeStateFile(contents: string): Promise<void> {
    const stateFilePath = this.stateFilePath!;
    const temporaryPath = `${stateFilePath}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, stateFilePath);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("INTERNAL_ERROR");
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
