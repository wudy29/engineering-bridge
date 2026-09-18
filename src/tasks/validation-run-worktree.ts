import fs from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ValidationRunError, type ValidationRun } from "./validation-run.js";

export type OwnedValidationWorktree = NonNullable<ValidationRun["owned_worktree"]>;
export type ValidationWorktreeGit = (cwd: string, args: readonly string[], input?: string) => Promise<string>;
type Identity = NonNullable<OwnedValidationWorktree["parent_identity"]>;
const MARKER = ".engineering-bridge-validation-run";

function verified(condition: unknown): asserts condition {
  if (!condition) throw new ValidationRunError("VALIDATION_WORKTREE_UNVERIFIED");
}
function canonicalPath(path: string): void {
  verified(isAbsolute(path) && !path.includes("\0") && resolve(path) === path);
}
function gitAbsolutePath(value: string): string {
  verified(isAbsolute(value) && !value.includes("\0"));
  const segments = value.split(process.platform === "win32" ? /[\\/]/ : /\//);
  verified(!segments.includes(".") && !segments.includes(".."));
  // Git uses forward slashes on Windows; retained paths use the host canonical form.
  return resolve(value);
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
}
function same(left: Identity, right: Identity | null | undefined): void {
  verified(right && left.dev === right.dev && left.ino === right.ino);
}
async function identity(path: string, kind: "directory" | "file", privateMode = false): Promise<Identity> {
  canonicalPath(path);
  const stat = await fs.lstat(path, { bigint: true });
  verified(kind === "directory" ? stat.isDirectory() : stat.isFile());
  verified(await fs.realpath(path) === path);
  if (privateMode && process.platform !== "win32") {
    verified((Number(stat.mode) & 0o077) === 0 && Number(stat.uid) === process.getuid?.());
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
async function smallFile(path: string): Promise<string> {
  const before = await fs.lstat(path, { bigint: true });
  verified(before.isFile() && before.size <= 4096n);
  const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    verified(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino);
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await fs.lstat(path, { bigint: true });
    verified(length <= 4096 && after.isFile() && after.dev === before.dev && after.ino === before.ino);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}
async function absent(path: string): Promise<void> {
  try { await fs.lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  verified(false);
}
async function contents(path: string, expected: string[]): Promise<void> {
  verified(JSON.stringify((await fs.readdir(path)).sort()) === JSON.stringify([...expected].sort()));
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await fs.open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
function registration(output: string, worktreePath: string, baseHead: string | null): void {
  const matching = output.split("\0\0").map((entry) => entry.split("\0"))
    .filter((entry) => entry[0]?.startsWith("worktree ") && gitAbsolutePath(entry[0].slice(9)) === worktreePath);
  verified(matching.length === 1 && matching[0]!.includes(`HEAD ${baseHead}`) && matching[0]!.includes("detached"));
  verified(!matching[0]!.some((line) => line.startsWith("locked") || line.startsWith("prunable")));
}

export class ValidationRunWorktree {
  constructor(private readonly expectedTempRoot: string) {
    canonicalPath(expectedTempRoot);
  }

  plan(run: ValidationRun): OwnedValidationWorktree {
    verified(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run.validation_run_id));
    const parent = join(this.expectedTempRoot, `engineering-bridge-validation-${run.validation_run_id}`);
    return {
      expected_temp_root: this.expectedTempRoot, parent_path: parent, worktree_path: join(parent, "worktree"),
      parent_identity: null, common_git_dir: null, run_marker: run.validation_run_id,
    };
  }

  private owned(run: ValidationRun): OwnedValidationWorktree {
    const owned = run.owned_worktree;
    const plan = this.plan(run);
    verified(owned && owned.expected_temp_root === plan.expected_temp_root && owned.parent_path === plan.parent_path &&
      owned.worktree_path === plan.worktree_path && owned.run_marker === plan.run_marker);
    return owned;
  }

  private async outsideWorkspace(run: ValidationRun): Promise<void> {
    await identity(run.workspace_root, "directory");
    verified(!inside(run.workspace_root, this.expectedTempRoot) && !inside(this.expectedTempRoot, run.workspace_root));
  }

  private async parent(run: ValidationRun): Promise<OwnedValidationWorktree> {
    const owned = this.owned(run);
    await this.outsideWorkspace(run);
    same(await identity(this.expectedTempRoot, "directory", true), owned.temp_root_identity);
    same(await identity(owned.parent_path, "directory", true), owned.parent_identity);
    same(await identity(join(owned.parent_path, MARKER), "file", true), owned.marker_identity);
    verified(await smallFile(join(owned.parent_path, MARKER)) === owned.run_marker + "\n");
    return owned;
  }

  async createParent(run: ValidationRun): Promise<OwnedValidationWorktree> {
    const owned = this.owned(run);
    for (const [key, value] of Object.entries(owned)) {
      if (key.endsWith("_identity") || key === "admin_path" || key === "common_git_dir") verified(value == null);
    }
    await this.outsideWorkspace(run);
    // Only the private root is created here; its existing ancestor must already be canonical.
    verified(await fs.realpath(dirname(this.expectedTempRoot)) === dirname(this.expectedTempRoot));
    try { await fs.mkdir(this.expectedTempRoot, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const rootIdentity = await identity(this.expectedTempRoot, "directory", true);
    await fs.mkdir(owned.parent_path, { mode: 0o700 });
    const parentIdentity = await identity(owned.parent_path, "directory", true);
    const markerPath = join(owned.parent_path, MARKER);
    const marker = await fs.open(markerPath, "wx", 0o600);
    try { await marker.writeFile(owned.run_marker + "\n"); await marker.sync(); } finally { await marker.close(); }
    const markerIdentity = await identity(markerPath, "file", true);
    await syncDirectory(owned.parent_path);
    await syncDirectory(this.expectedTempRoot);
    same(await identity(this.expectedTempRoot, "directory", true), rootIdentity);
    same(await identity(owned.parent_path, "directory", true), parentIdentity);
    same(await identity(markerPath, "file", true), markerIdentity);
    verified(await smallFile(markerPath) === owned.run_marker + "\n");
    await contents(owned.parent_path, [MARKER]);
    return { ...owned, temp_root_identity: rootIdentity, parent_identity: parentIdentity, marker_identity: markerIdentity };
  }

  private async repository(run: ValidationRun, git: ValidationWorktreeGit): Promise<{ workspaceIdentity: Identity; commonDir: string; commonIdentity: Identity }> {
    const workspaceIdentity = await identity(run.workspace_root, "directory");
    verified(gitAbsolutePath((await git(run.workspace_root, ["rev-parse", "--show-toplevel"])).trim()) === run.workspace_root);
    const commonDir = gitAbsolutePath((await git(run.workspace_root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
    const commonIdentity = await identity(commonDir, "directory");
    same(await identity(run.workspace_root, "directory"), workspaceIdentity);
    return { workspaceIdentity, commonDir, commonIdentity };
  }

  private async worktree(owned: OwnedValidationWorktree): Promise<Pick<OwnedValidationWorktree,
    "worktree_identity" | "git_pointer_identity" | "admin_path" | "admin_identity" | "admin_gitdir_identity">> {
    verified(owned.common_git_dir);
    const worktreeIdentity = await identity(owned.worktree_path, "directory");
    const pointerPath = join(owned.worktree_path, ".git");
    const pointerIdentity = await identity(pointerPath, "file");
    const pointer = await smallFile(pointerPath);
    verified(pointer.startsWith("gitdir: ") && pointer.endsWith("\n"));
    const adminPath = gitAbsolutePath(pointer.slice(8).trimEnd());
    verified(dirname(adminPath) === join(owned.common_git_dir, "worktrees"));
    await identity(dirname(adminPath), "directory");
    const adminIdentity = await identity(adminPath, "directory");
    const backrefPath = join(adminPath, "gitdir");
    const backrefIdentity = await identity(backrefPath, "file");
    verified(gitAbsolutePath((await smallFile(backrefPath)).trimEnd()) === pointerPath);
    const commonPointer = join(adminPath, "commondir");
    await identity(commonPointer, "file");
    verified(resolve(adminPath, (await smallFile(commonPointer)).trimEnd()) === owned.common_git_dir);
    return { worktree_identity: worktreeIdentity, git_pointer_identity: pointerIdentity,
      admin_path: adminPath, admin_identity: adminIdentity, admin_gitdir_identity: backrefIdentity };
  }

  async register(run: ValidationRun, git: ValidationWorktreeGit): Promise<OwnedValidationWorktree> {
    const owned = await this.parent(run);
    verified(run.base_head !== null && owned.common_git_dir === null && owned.worktree_identity == null && owned.admin_path == null);
    await contents(owned.parent_path, [MARKER]);
    const repository = await this.repository(run, git);
    await this.parent(run);
    await contents(owned.parent_path, [MARKER]);
    await git(run.workspace_root, ["worktree", "add", "--detach", "--", owned.worktree_path, run.base_head]);
    const receipt = { ...owned, common_git_dir: repository.commonDir, common_git_dir_identity: repository.commonIdentity,
      workspace_identity: repository.workspaceIdentity };
    const worktree = await this.worktree(receipt);
    registration(await git(run.workspace_root, ["worktree", "list", "--porcelain", "-z"]), owned.worktree_path, run.base_head);
    const current = await this.repository(run, git);
    verified(current.commonDir === repository.commonDir);
    same(current.commonIdentity, repository.commonIdentity);
    same(current.workspaceIdentity, repository.workspaceIdentity);
    await this.parent(run);
    const complete = { ...receipt, ...worktree };
    await this.verifyFiles(run, complete);
    return complete;
  }

  private async verifyFiles(run: ValidationRun, owned: OwnedValidationWorktree): Promise<void> {
    await this.parent(run);
    same(await identity(run.workspace_root, "directory"), owned.workspace_identity);
    verified(owned.common_git_dir && owned.admin_path);
    same(await identity(owned.common_git_dir, "directory"), owned.common_git_dir_identity);
    const worktree = await this.worktree(owned);
    verified(worktree.admin_path === owned.admin_path);
    for (const key of ["worktree_identity", "git_pointer_identity", "admin_identity", "admin_gitdir_identity"] as const) {
      same(worktree[key]!, owned[key]);
    }
    await contents(owned.parent_path, [MARKER, "worktree"]);
  }

  async cleanup(run: ValidationRun, git: ValidationWorktreeGit, signal: AbortSignal, quiescent: boolean): Promise<void> {
    signal.throwIfAborted();
    verified(quiescent === true);
    const owned = this.owned(run);
    await this.verifyFiles(run, owned);
    signal.throwIfAborted();
    const repository = await this.repository(run, git);
    verified(repository.commonDir === owned.common_git_dir);
    same(repository.commonIdentity, owned.common_git_dir_identity);
    same(repository.workspaceIdentity, owned.workspace_identity);
    signal.throwIfAborted();
    registration(await git(run.workspace_root, ["worktree", "list", "--porcelain", "-z"]), owned.worktree_path, run.base_head);
    signal.throwIfAborted();
    await this.verifyFiles(run, owned);
    signal.throwIfAborted();
    await git(run.workspace_root, ["worktree", "remove", "--force", "--", owned.worktree_path]);
    signal.throwIfAborted();
    await this.parent(run);
    await absent(owned.worktree_path);
    await absent(owned.admin_path!);
    same(await identity(run.workspace_root, "directory"), owned.workspace_identity);
    same(await identity(owned.common_git_dir!, "directory"), owned.common_git_dir_identity);
    signal.throwIfAborted();
    const entries = await git(run.workspace_root, ["worktree", "list", "--porcelain", "-z"]);
    verified(!entries.split("\0").some((entry) => entry.startsWith("worktree ") && gitAbsolutePath(entry.slice(9)) === owned.worktree_path));
    signal.throwIfAborted();
    await absent(owned.worktree_path);
    await absent(owned.admin_path!);
    same(await identity(run.workspace_root, "directory"), owned.workspace_identity);
    same(await identity(owned.common_git_dir!, "directory"), owned.common_git_dir_identity);
    signal.throwIfAborted();
    await this.removeParent(run, signal);
  }

  private async removeParent(run: ValidationRun, signal: AbortSignal): Promise<void> {
    const owned = await this.parent(run);
    await contents(owned.parent_path, [MARKER]);
    signal.throwIfAborted();
    await fs.unlink(join(owned.parent_path, MARKER));
    signal.throwIfAborted();
    same(await identity(this.expectedTempRoot, "directory", true), owned.temp_root_identity);
    same(await identity(owned.parent_path, "directory", true), owned.parent_identity);
    await contents(owned.parent_path, []);
    signal.throwIfAborted();
    await fs.rmdir(owned.parent_path);
    await syncDirectory(this.expectedTempRoot);
  }

}
