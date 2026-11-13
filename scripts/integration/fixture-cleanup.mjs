import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export function gone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

export async function releaseFixtureDescendant(pid, release) {
  if (gone(pid)) return;
  await fs.writeFile(release, "release owned fixture\n");
  const end = performance.now() + 8000;
  // A marker alone cannot prove exit; an exited process cannot write another marker.
  while (!gone(pid)) { assert.ok(performance.now() < end, "owned descendant exit"); await delay(10); }
}
