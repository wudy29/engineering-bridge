import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { isPathWithin, isWorkspaceRoot } from "../../../src/workspaces/workspace-paths.js";

test("F1: Windows drive and UNC roots contain exact roots and same-volume children", () => {
  const cases = [
    ["C:\\", "C:\\workspace"],
    ["C:\\", "C:\\root"],
    ["C:\\", "C:\\"],
    ["C:\\root", "C:\\root"],
    ["C:\\root", "C:\\root\\child"],
    ["C:\\root", "C:\\root\\..safe"],
    ["\\\\server\\share\\", "\\\\server\\share\\workspace"],
    ["\\\\server\\share\\", "\\\\server\\share\\"],
    ["\\\\server\\share\\root", "\\\\server\\share\\root\\child"]
  ] as const;
  for (const [root, candidate] of cases) {
    assert.equal(isPathWithin(root, candidate, win32), true, JSON.stringify({ root, candidate }));
  }
});

test("F1: Windows containment rejects siblings, parent escapes, drives, servers and shares", () => {
  const cases = [
    ["C:\\root", "C:\\root-evil"],
    ["C:\\root", "C:\\root\\.."],
    ["C:\\root", "C:\\root\\..\\outside"],
    ["C:\\", "D:\\workspace"],
    ["C:\\root", "D:\\root\\child"],
    ["\\\\server\\share\\", "\\\\server\\other\\workspace"],
    ["\\\\server\\share\\", "\\\\other\\share\\workspace"],
    ["\\\\server\\share\\root", "\\\\server\\share\\root-evil"],
    ["\\\\server\\share\\root", "\\\\server\\share\\root\\..\\outside"]
  ] as const;
  for (const [root, candidate] of cases) {
    assert.equal(isPathWithin(root, candidate, win32), false, JSON.stringify({ root, candidate }));
  }
});

test("F1: POSIX containment handles filesystem roots and preserves path boundaries", () => {
  const cases = [
    ["/", "/", true],
    ["/", "/root", true],
    ["/", "/root/child", true],
    ["/root", "/root", true],
    ["/root", "/root/child", true],
    ["/root", "/root/..safe", true],
    ["/root", "/root-evil", false],
    ["/root", "/root/..", false],
    ["/root", "/root/../outside", false]
  ] as const;
  for (const [root, candidate, expected] of cases) {
    assert.equal(isPathWithin(root, candidate, posix), expected, JSON.stringify({ root, candidate }));
  }
});

test("F2: Windows workspace roots accept normalized drive-qualified and UNC paths", () => {
  for (const root of ["C:\\workspace", "C:\\", "\\\\server\\share\\workspace", "\\\\server\\share\\"]) {
    assert.equal(isWorkspaceRoot(root, win32), true, JSON.stringify(root));
  }
});

test("F2: Windows workspace roots reject drive-relative, incomplete, namespace and non-normalized paths", () => {
  const invalidRoots = [
    "\\root", "\\workspace\\child", "\\", "/root", "C:relative", "C:", "relative\\path", "",
    "C:/workspace", "C:\\root\\..\\workspace", "C:\\root\\.\\child", "C:\\\\workspace",
    "1:\\workspace", "\\\\server", "\\\\server\\", "\\\\server\\share",
    "\\\\server\\\\share\\workspace", "\\\\server\\share\\root\\..\\workspace",
    "\\\\server\\.\\workspace", "\\\\server\\..\\workspace", "\\\\..\\share\\workspace",
    "\\\\.\\share\\workspace", "\\\\?\\C:\\workspace", "\\\\?\\UNC\\server\\share\\workspace",
    "\\\\server\\C:\\workspace"
  ];
  for (const root of invalidRoots) assert.equal(isWorkspaceRoot(root, win32), false, JSON.stringify(root));
});

test("F2: POSIX workspace roots retain normalized absolute path semantics", () => {
  for (const root of ["/", "/root", "/root/child"]) assert.equal(isWorkspaceRoot(root, posix), true, root);
  for (const root of ["", "relative/path", "/root/../child", "/root/./child", "//root", "\\root", "C:relative"]) {
    assert.equal(isWorkspaceRoot(root, posix), false, JSON.stringify(root));
  }
  for (const root of [undefined, null, 1, {}]) assert.equal(isWorkspaceRoot(root, posix), false);
});
