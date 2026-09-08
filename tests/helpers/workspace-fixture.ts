import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic workspace names for registry/catalog/task unit tests. Filesystem
// integration tests create their own real directories with mkdtemp instead.
export function workspaceFixture(...parts: string[]): string {
  return join(tmpdir(), "engineering-bridge-workspace-fixture", ...parts);
}
