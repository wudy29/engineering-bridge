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
