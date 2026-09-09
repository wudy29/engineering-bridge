import { execFileSync } from "node:child_process";

// Set policy in disposable test repositories, including their linked worktrees.
export function isolateGitLineEndings(root: string): void {
  execFileSync("git", ["config", "--local", "core.autocrlf", "false"], { cwd: root });
  execFileSync("git", ["config", "--local", "core.eol", "lf"], { cwd: root });
}
