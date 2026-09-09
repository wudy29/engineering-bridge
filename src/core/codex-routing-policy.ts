export const CODEX_ROUTING_POLICY_ENV = "ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY";

export type CodexRoutingPolicy = "inherit" | "explicit";

export function parseCodexRoutingPolicy(value: string | undefined): CodexRoutingPolicy {
  if (value === undefined) return "inherit";
  if (value === "inherit" || value === "explicit") return value;
  throw new Error(`Invalid ${CODEX_ROUTING_POLICY_ENV}: expected "inherit" or "explicit".`);
}
