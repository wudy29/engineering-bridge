import { realpath, stat } from "node:fs/promises";
import { CoreError } from "../core/errors.js";
import path from "node:path";

// Lexical checks only; callers must still enforce their canonicalization boundary.
export function isWorkspaceRoot(
  root: unknown,
  paths: Pick<typeof path, "isAbsolute" | "normalize" | "sep"> = path
): root is string {
  if (typeof root !== "string" || root.length === 0 ||
      !paths.isAbsolute(root) || paths.normalize(root) !== root) return false;
  if (paths.sep !== "\\") return true;
  if (/^[A-Za-z]:\\/.test(root)) return true;

  // Ordinary UNC paths require both server and share. Device namespaces and
  // drive-relative/root-relative paths are not trusted workspace roots.
  const unc = /^\\\\([^\\/:*?"<>|\u0000-\u001f]+)\\([^\\/:*?"<>|\u0000-\u001f]+)\\/.exec(root);
  return unc !== null && ![".", ".."].includes(unc[1]!) && ![".", ".."].includes(unc[2]!);
}

// Operands come from canonicalization in the onboarding service.
export function isPathWithin(
  root: string,
  candidate: string,
  paths: Pick<typeof path, "relative" | "isAbsolute" | "sep"> = path
): boolean {
  const relative = paths.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

// This selects cwd only. It neither grants access nor scopes controlled writes.
export async function resolveWorkingDirectory(root: string, subpath: string): Promise<string> {
  // Use one portable relative syntax; reject drive-relative and UNC forms even
  // on POSIX so a stored request cannot acquire a different meaning on Windows.
  if (typeof subpath !== "string" || subpath.length === 0 ||
      subpath.includes("\0") || subpath.includes("\\") ||
      path.posix.isAbsolute(subpath) || /^[A-Za-z]:/.test(subpath) ||
      subpath.split("/").includes("..")) {
    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  }
  let canonicalRoot: string;
  let directory: string;
  try {
    canonicalRoot = await realpath(root);
    directory = await realpath(path.resolve(canonicalRoot, subpath));
  } catch {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  if (!isPathWithin(canonicalRoot, directory)) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  return directory;
}
