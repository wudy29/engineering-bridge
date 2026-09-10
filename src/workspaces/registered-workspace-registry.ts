import { realpathSync } from "node:fs";

import { CoreError } from "../core/errors.js";
import { isWorkspaceRoot } from "./workspace-paths.js";

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly allow_write?: boolean | undefined;
}

export interface WorkspaceLookup {
  readonly id: string;
  readonly root: string;
  readonly allowWrite: boolean;
  readonly source: "manual" | "managed";
}

type Registration = {
  root: string;
  canonicalRoot: string;
  allowWrite: boolean;
  source: "manual" | "managed";
};

export class RegisteredWorkspaceRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly canonicalRoots = new Map<string, string>();
  private readonly canonicalize: (root: string) => string;

  constructor(
    entries: readonly WorkspaceRegistration[],
    canonicalize: (root: string) => string = bestEffortCanonicalRoot
  ) {
    this.canonicalize = canonicalize;
    for (const entry of entries) {
      if (typeof entry.id !== "string" || entry.id.length === 0 ||
          !isWorkspaceRoot(entry.root) ||
          (entry.allow_write !== undefined && typeof entry.allow_write !== "boolean") ||
          this.registrations.has(entry.id)) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      }
      const canonicalRoot = canonicalize(entry.root);
      this.registrations.set(entry.id, {
        root: entry.root,
        canonicalRoot,
        allowWrite: entry.allow_write ?? false,
        source: "manual"
      });
      // Duplicate canonical roots among manual entries do not fail startup;
      // the first entry wins for canonical lookup.
      if (!this.canonicalRoots.has(canonicalRoot)) this.canonicalRoots.set(canonicalRoot, entry.id);
    }
  }

  resolve(workspaceId: string): string {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return registration.root;
  }

  resolveExecution(workspaceId: string): { root: string; allowWrite: boolean } {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return { root: registration.root, allowWrite: registration.allowWrite };
  }

  resolveWritable(workspaceId: string): string {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    if (!registration.allowWrite) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return registration.root;
  }

  findByRoot(canonicalRoot: string): WorkspaceLookup | undefined {
    this.refreshManualCanonicalRoots();
    const id = this.canonicalRoots.get(canonicalRoot);
    if (id === undefined) return undefined;
    const registration = this.registrations.get(id);
    if (registration === undefined) return undefined;
    return {
      id,
      root: registration.root,
      allowWrite: registration.allowWrite,
      source: registration.source
    };
  }

  registerManaged(id: string, root: string, allowWrite = false): void {
    if (!isWorkspaceRoot(root)) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    const existing = this.registrations.get(id);
    if (existing !== undefined) {
      if (existing.root === root) return;
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    const canonicalRoot = this.canonicalize(root);
    this.refreshManualCanonicalRoots();
    if (this.canonicalRoots.has(canonicalRoot)) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    this.registrations.set(id, { root, canonicalRoot, allowWrite, source: "managed" });
    this.canonicalRoots.set(canonicalRoot, id);
  }

  private refreshManualCanonicalRoots(): void {
    this.canonicalRoots.clear();
    for (const [id, registration] of this.registrations) {
      const canonicalRoot = registration.source === "manual"
        ? this.canonicalize(registration.root)
        : registration.canonicalRoot;
      if (!this.canonicalRoots.has(canonicalRoot)) this.canonicalRoots.set(canonicalRoot, id);
    }
  }

  sourceOf(workspaceId: string): "manual" | "managed" {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return registration.source;
  }

  // Grants controlled-write authorization for one managed workspace. Manual
  // workspaces stay authoritative through workspaces.json only. Idempotent.
  authorizeWrite(workspaceId: string): void {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    if (registration.source !== "managed") throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    registration.allowWrite = true;
  }
}

function bestEffortCanonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}
