import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_ROUTING_POLICY_ENV,
  parseCodexRoutingPolicy
} from "../../src/core/codex-routing-policy.js";

test("Codex routing policy defaults to inherit when unset", () => {
  assert.equal(parseCodexRoutingPolicy(undefined), "inherit");
});

test("Codex routing policy accepts only inherit and explicit", () => {
  assert.equal(parseCodexRoutingPolicy("inherit"), "inherit");
  assert.equal(parseCodexRoutingPolicy("explicit"), "explicit");
});

test("Codex routing policy rejects invalid values without correction", () => {
  for (const value of ["STRICT", "max", "true", "", " Explicit "]) {
    assert.throws(
      () => parseCodexRoutingPolicy(value),
      (error: unknown) => error instanceof Error &&
        error.message.startsWith(`Invalid ${CODEX_ROUTING_POLICY_ENV}: expected`)
    );
  }
});
