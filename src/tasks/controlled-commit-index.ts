import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import { CoreError } from "../core/errors.js";
import { runBoundedGit, type GitProcessOptions, type GitStarter } from "../executors/bounded-git-process.js";

const failure = (): CoreError => new CoreError("WORKSPACE_PRECONDITION_FAILED");
type CommitOptions = GitProcessOptions & { readonly isQuiescent?: () => boolean };

// Own exactly one native index lock. The shared index stays unchanged until
// an approved commit is published; all staging happens in a private copy.
export async function withLockedCommitIndex<T>(
  root: string,
  start: GitStarter,
  options: CommitOptions,
  action: (index: ControlledCommitIndex) => Promise<T>
): Promise<T> {
  const pathResult = await runBoundedGit(start, root, ["rev-parse", "--git-path", "index"], undefined, failure, options);
  const indexPath = pathResult.stdout.replace(process.platform === "win32" ? /\r?\n$/u : /\n$/u, "");
  if (pathResult.code !== 0 || indexPath.length === 0) throw failure();
  const path = resolve(root, indexPath);
  let lock: FileHandle;
  try { lock = await open(`${path}.lock`, "wx", 0o666); }
  catch { throw failure(); }
  const index = new ControlledCommitIndex(root, path, lock, start, options);
  try {
    await index.initialize();
    return await action(index);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw failure();
  } finally {
    await index.close();
  }
}

export class ControlledCommitIndex {
  private readonly privatePath: string;
  private keepLock = false;
  private installed = false;

  constructor(
    private readonly root: string,
    private readonly path: string,
    private readonly lock: FileHandle,
    private readonly start: GitStarter,
    private readonly options: CommitOptions
  ) {
    this.privatePath = `${path}.bridge-${randomUUID()}`;
  }

  async initialize(): Promise<void> {
    let original: Buffer | undefined;
    try {
      original = await readFile(this.path);
      await this.lock.chmod((await stat(this.path)).mode & 0o777);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (original === undefined) await this.git(["read-tree", "--empty"]);
    else await writeFile(this.privatePath, original, { flag: "wx", mode: 0o600 });
  }

  async git(args: readonly string[], input?: string): Promise<string> {
    const starter: GitStarter = (executable, argv, options) => this.start(executable, argv, {
      ...options, env: { ...process.env, ...options.env, GIT_INDEX_FILE: this.privatePath }
    });
    const result = await runBoundedGit(starter, this.root, args, input, failure, this.options);
    if (result.code !== 0) throw failure();
    return result.stdout;
  }

  async publish(
    tree: string,
    baseHead: string | null,
    message: string,
    verifyPrepared: () => Promise<void>
  ): Promise<string> {
    const commit = (await this.git([
      "-c", "commit.gpgSign=false", "commit-tree", tree,
      ...(baseHead === null ? [] : ["-p", baseHead]), "-m", message
    ])).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(commit) ||
        (await this.git(["rev-parse", `${commit}^{tree}`])).trim() !== tree) throw failure();

    // Prepare the replacement on the same filesystem and close it before
    // publication (also required for Windows rename semantics).
    await this.lock.writeFile(await readFile(this.privatePath));
    await this.lock.close();
    let closed = false;
    let commitMayHaveStarted = false;
    const starter: GitStarter = (executable, args, options) => {
      const child = this.start(executable, args, options);
      child.once("close", () => { closed = true; });
      return child;
    };
    try {
      await runBoundedGit(starter, this.root, [
        "-c", "core.hooksPath=/dev/null", "update-ref", "-m",
        `commit${baseHead === null ? " (initial)" : ""}: ${message}`, "--stdin"
      ], `start\nupdate HEAD ${commit} ${baseHead ?? "0".repeat(commit.length)}\nprepare\n`, failure, {
        ...this.options,
        afterPrepare: verifyPrepared,
        beforeCommit: () => {
          commitMayHaveStarted = true;
          this.keepLock = true;
          this.options.beforeCommit?.();
        }
      });
    } catch {
      // Never release the prepared index if a timed-out publisher may still
      // be alive. Retain Git's lock for explicit recovery instead.
      if (commitMayHaveStarted && !closed) {
        this.keepLock = true;
        throw failure();
      }
    }
    // A command may fail after publishing. Reconcile only our known object,
    // never accept an arbitrary newly observed HEAD as our commit.
    const head = await runBoundedGit(this.start, this.root, ["rev-parse", "--verify", "--quiet", "HEAD"], undefined, failure, this.options);
    if (head.code !== 0 || head.stdout.trim() !== commit) throw failure();
    this.keepLock = true;
    if (this.options.isQuiescent?.() === false) throw failure();
    await rename(`${this.path}.lock`, this.path);
    this.installed = true;
    return commit;
  }

  async close(): Promise<void> {
    await this.lock.close();
    // A private-index command can outlive rejection before commit was sent.
    // Retain both owned files until explicit recovery can prove quiescence.
    if (this.options.isQuiescent?.() === false) { this.keepLock = true; throw failure(); }
    await unlink(this.privatePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!this.keepLock && !this.installed) await unlink(`${this.path}.lock`);
  }
}
