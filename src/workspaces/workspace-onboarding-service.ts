import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";

import { CoreError } from "../core/errors.js";
import {
  runBoundedGit,
  type GitProcessOptions,
  type GitStarter
} from "../executors/bounded-git-process.js";
import { ManagedWorkspaceCatalog } from "./managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "./registered-workspace-registry.js";
import { isPathWithin, isWorkspaceRoot } from "./workspace-paths.js";

export type Canonicalizer = (path: string) => Promise<string>;
export type { GitStarter };

export interface BindWorkspaceResult {
  readonly workspace_id: string;
  readonly root: string;
  readonly allow_write: boolean;
  readonly source: "manual" | "managed";
}

export interface CreateWorkspaceResult {
  readonly workspace_id: string;
  readonly root: string;
  readonly allow_write: boolean;
  readonly git: { readonly initialized: true; readonly head: "unborn" };
}

export class WorkspaceOnboardingService {
  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly catalog: ManagedWorkspaceCatalog,
    private readonly approvedRoots: readonly string[],
    private readonly canonicalize: Canonicalizer = realpath,
    private readonly startProcess: GitStarter = spawn,
    private readonly gitProcessOptions: GitProcessOptions = {}
  ) {
    if (!approvedRoots.every((root) => isWorkspaceRoot(root))) {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
  }

  async bind(request: { project_path: string }): Promise<BindWorkspaceResult> {
    const canonical = await this.canonicalizeWithinApprovedRoot(request.project_path);
    if (!(await isDirectory(canonical))) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const existing = this.registry.findByRoot(canonical);
    if (existing !== undefined) {
      return {
        workspace_id: existing.id,
        root: existing.root,
        allow_write: existing.allowWrite,
        source: existing.source
      };
    }
    const { id } = await this.catalog.registerOnce(canonical);
    this.registry.registerManaged(id, canonical);
    return { workspace_id: id, root: canonical, allow_write: false, source: "managed" };
  }

  async create(request: { parent: string; name: string }): Promise<CreateWorkspaceResult> {
    if (!isSingleSegment(request.name)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const canonicalParent = await this.canonicalizeWithinApprovedRoot(request.parent);
    const target = join(canonicalParent, request.name);
    if (await pathExists(target)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    try {
      await mkdir(target);
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    try {
      await this.git(target, ["init"]);
    } catch {
      // Best-effort removal of the empty directory created by this call only.
      await rmdir(target).catch((): void => {});
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const { id } = await this.catalog.registerOnce(target);
    this.registry.registerManaged(id, target);
    return {
      workspace_id: id,
      root: target,
      allow_write: false,
      git: { initialized: true, head: "unborn" }
    };
  }

  async authorizeWrite(workspaceId: string): Promise<{ workspace_id: string; allow_write: true }> {
    const root = this.registry.resolve(workspaceId);
    if (this.registry.sourceOf(workspaceId) !== "managed") {
      // Manual workspaces stay authoritative through workspaces.json only.
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    // Persist first, then update the runtime registry: a failed persist leaves
    // no half-authorized runtime state, and the registry update cannot fail.
    await this.catalog.authorize(root);
    this.registry.authorizeWrite(workspaceId);
    return { workspace_id: workspaceId, allow_write: true };
  }

  private async canonicalizeWithinApprovedRoot(path: string): Promise<string> {
    let canonical: string;
    try {
      canonical = await this.canonicalize(path);
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const roots: string[] = [];
    for (const root of this.approvedRoots) {
      try {
        roots.push(await this.canonicalize(root));
      } catch {
        // This approved root cannot be verified, so it grants no authorization;
        // healthy roots below are still eligible to contain the candidate.
      }
    }
    if (!roots.some((root) => isPathWithin(root, canonical))) {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    return canonical;
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await runBoundedGit(
      this.startProcess,
      cwd,
      args,
      undefined,
      () => new CoreError("WORKSPACE_PRECONDITION_FAILED"),
      this.gitProcessOptions
    );
    if (result.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return result.stdout;
  }
}

function isSingleSegment(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") &&
    name !== "." && name !== "..";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
