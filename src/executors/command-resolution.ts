import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// Minimal shared command-resolution logic for the executors.
//
// On Windows it resolves a bare command name (for example `codex` or `dsh`)
// against the host PATH with Windows command semantics:
//
//  1. PATH is looked up case-insensitively (the environment may spell it
//     PATH, Path or path).
//  2. Only absolute PATH entries are searched; relative entries are skipped.
//  3. PATHEXT is used for discovery only: entries are split on ";", trimmed,
//     normalized to uppercase with a leading dot, and ordered exactly as the
//     host provided them (".COM;.EXE;.BAT;.CMD" is the default when absent).
//  4. Priority: a directly spawnable real executable (.COM/.EXE) anywhere on
//     PATH wins over any .BAT/.CMD shim; within one class the first PATH
//     entry and PATHEXT order decide.
//  5. A .BAT/.CMD npm shim is never launched through a shell: its real Node
//     target is derived from the shim's location via nodeTarget (npm global
//     and local node_modules/.bin layouts) and launched with process.execPath.
//     When the target cannot be derived, resolution fails closed as `bare`
//     and the caller keeps its existing shell-free fallback.
//
// On non-Windows platforms resolution is PATH-first and stays out of the way:
// an executable `command` on an absolute PATH entry keeps the historical
// `bare` result, so the original spawn and the inherited PATH lookup are
// unchanged. Only a PATH miss may consult the opt-in HOME-relative fallback in
// ResolveCommandOptions; without that option the historical `bare` result is
// returned, so executors that do not opt in are byte-for-byte unchanged.
//
// This module performs discovery only: it never builds or runs shell command
// text, and nothing here ever goes through cmd.exe, ComSpec or shell:true.

export type ResolvedCommand =
  | { readonly kind: "direct"; readonly executable: string }
  | { readonly kind: "node-launcher"; readonly scriptPath: string }
  | { readonly kind: "bare" };

export interface ResolveCommandOptions {
  // npm package target derived from a .cmd/.bat shim location, for example
  // ["@openai", "codex", "bin", "codex.js"] or
  // ["@deepseek-ai", "dsh", "lib", "bin.js"]. Tried as
  // <shimDir>\node_modules\<target> (global npm layout) and
  // <shimDir>\..\<target> (local node_modules/.bin layout).
  readonly nodeTarget?: readonly string[];
  // Opt-in POSIX fallback given as HOME-relative path segments, for example
  // [".local", "bin", "codex"]. Consulted only when the host PATH produced no
  // executable `command`, and only when HOME is an absolute path; the
  // candidate must then be a regular executable file. Ignored on Windows.
  // Callers opt in explicitly, so no executor inherits a fallback.
  readonly homeRelativeFallback?: readonly string[];
  // Injectable for tests; defaults to the running platform.
  readonly platform?: NodeJS.Platform;
}

const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const REAL_EXECUTABLE_EXTS = new Set([".COM", ".EXE"]);
const SHIM_EXTS = new Set([".BAT", ".CMD"]);
// A bare command name; a name containing a path separator is never searched on
// PATH and never combined with the HOME fallback.
const BARE_COMMAND = /^[A-Za-z0-9._-]+$/u;

export function resolveCommand(
  host: Readonly<NodeJS.ProcessEnv>,
  command: string,
  options: ResolveCommandOptions = {}
): ResolvedCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return resolvePosix(host, command, options);
  if (!BARE_COMMAND.test(command)) return { kind: "bare" };

  // Real executables first, across the whole PATH.
  const direct = findInPath(host, command, (ext) => REAL_EXECUTABLE_EXTS.has(ext));
  if (direct !== undefined) return { kind: "direct", executable: direct };

  // Then .cmd/.bat shims, across the whole PATH. A shim is only usable when
  // its real Node target can be derived; without nodeTarget (or when the
  // target is missing) there is no shell-free way to launch it, so resolution
  // fails closed as bare.
  const shim = findInPath(host, command, (ext) => SHIM_EXTS.has(ext));
  if (shim === undefined || options.nodeTarget === undefined) return { kind: "bare" };
  const scriptPath = npmShimTarget(shim, options.nodeTarget);
  return scriptPath === undefined ? { kind: "bare" } : { kind: "node-launcher", scriptPath };
}

// POSIX resolution is PATH-first:
//
//  1. When an absolute PATH entry already names an executable `command`, the
//     caller keeps its historical bare spawn and the child performs the same
//     PATH lookup it always did; the fallback is not consulted at all.
//  2. Only a PATH miss may consult the opt-in HOME-relative fallback, and it
//     resolves to `direct` exclusively when the candidate is a regular
//     executable file. Absent, directory and non-executable candidates keep
//     the bare spawn rather than turning a PATH miss into a wrong spawn.
function resolvePosix(
  host: Readonly<NodeJS.ProcessEnv>,
  command: string,
  options: ResolveCommandOptions
): ResolvedCommand {
  if (!BARE_COMMAND.test(command)) return { kind: "bare" };
  if (findInPosixPath(host, command)) return { kind: "bare" };
  const fallback = options.homeRelativeFallback;
  if (fallback === undefined || fallback.length === 0) return { kind: "bare" };
  const home = envValue(host, "HOME");
  if (home === undefined || !isAbsolute(home)) return { kind: "bare" };
  const candidate = join(home, ...fallback);
  return isExecutableFile(candidate) ? { kind: "direct", executable: candidate } : { kind: "bare" };
}

function findInPosixPath(host: Readonly<NodeJS.ProcessEnv>, command: string): boolean {
  const pathValue = envValue(host, "PATH");
  if (pathValue === undefined) return false;
  for (const entry of pathValue.split(POSIX_PATH_DELIMITER)) {
    if (!isAbsolute(entry)) continue;
    if (isExecutableFile(join(entry, command))) return true;
  }
  return false;
}

// A usable candidate is a regular file this process may execute. A directory,
// a missing path or a plain non-executable file (for example a stray text file
// named `codex`) must never become a spawn target.
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(
  host: Readonly<NodeJS.ProcessEnv>,
  command: string,
  allowed: (extension: string) => boolean
): string | undefined {
  const pathValue = envValue(host, "PATH");
  if (pathValue === undefined) return undefined;
  const extensions = pathExtensions(host);
  for (const entry of pathValue.split(WINDOWS_PATH_DELIMITER)) {
    if (!isAbsolute(entry)) continue;
    for (const extension of extensions) {
      if (!allowed(extension)) continue;
      // Windows filesystem lookup is case-insensitive; the directory scan
      // mirrors that and returns the on-disk casing.
      const candidate = findCaseInsensitive(entry, `${command}${extension}`);
      if (candidate !== undefined && isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function findCaseInsensitive(directory: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return undefined;
  }
  const wanted = name.toLowerCase();
  const hit = entries.find((entry) => entry.toLowerCase() === wanted);
  return hit === undefined ? undefined : join(directory, hit);
}

function pathExtensions(host: Readonly<NodeJS.ProcessEnv>): string[] {
  const raw = envValue(host, "PATHEXT");
  const entries = (raw ?? DEFAULT_WINDOWS_PATHEXT.join(WINDOWS_PATH_DELIMITER))
    .split(WINDOWS_PATH_DELIMITER)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return DEFAULT_WINDOWS_PATHEXT;
  return entries.map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
}

function npmShimTarget(shimPath: string, nodeTarget: readonly string[]): string | undefined {
  const shimDir = dirname(shimPath);
  for (const candidate of [
    join(shimDir, "node_modules", ...nodeTarget),
    join(shimDir, "..", ...nodeTarget)
  ]) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function envValue(host: Readonly<NodeJS.ProcessEnv>, key: string): string | undefined {
  const needle = key.toLowerCase();
  for (const name of Object.keys(host)) {
    if (name.toLowerCase() !== needle) continue;
    const value = host[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  }
  return undefined;
}
