import { DomainError } from "./errors.js";
import type { EnvironmentRequirements } from "./env-definition.js";

/** What one backend can actually enforce. Each flag is a fact about the backend, never a promise. */
export interface CapabilityMatrix {
  write_confined: boolean;
  network_none: boolean;
  cpu_limit: boolean;
  memory_limit: boolean;
  pids_limit: boolean;
  ledger_readonly: boolean;
}

export interface CapabilityRequest {
  route?: boolean;
}

type Need = [requirement: string, capability: keyof CapabilityMatrix];

const needsOf = (requirements: EnvironmentRequirements, request: CapabilityRequest): Need[] => [
  ...(requirements.workspace_write === "confined" ? [["workspace_write", "write_confined"] as Need] : []),
  ...(requirements.network === "none" ? [["network", "network_none"] as Need] : []),
  ...(requirements.cpu !== undefined ? [["cpu", "cpu_limit"] as Need] : []),
  ...(requirements.memory !== undefined ? [["memory", "memory_limit"] as Need] : []),
  ...(requirements.pids !== undefined ? [["pids", "pids_limit"] as Need] : []),
  ...(request.route ? [["ledger_readonly", "ledger_readonly"] as Need] : []),
];

/** Names of requirements the backend cannot enforce, in a fixed order. Empty means the backend can run the definition. */
export const requirementGaps = (
  requirements: EnvironmentRequirements,
  capabilities: CapabilityMatrix,
  request: CapabilityRequest = {},
): string[] => needsOf(requirements, request).filter(([, capability]) => !capabilities[capability]).map(([requirement]) => requirement);

/** Refuses at prepare time. Callers must run this before creating any instance directory or process. */
export const assertCapabilities = (input: {
  requirements: EnvironmentRequirements;
  capabilities: CapabilityMatrix;
  route?: boolean;
}): void => {
  const unmet = requirementGaps(input.requirements, input.capabilities, { route: input.route });
  if (unmet.length === 0) return;
  throw new DomainError("ENVIRONMENT_CAPABILITY_UNSUPPORTED", "the backend cannot enforce the requested environment", false, { unmet });
};

/** Trusted host deliberately makes no enforcement claims, including on macOS. */
export const hostCapabilities = (_input?: { platform: NodeJS.Platform; sandboxExecAvailable?: boolean }): CapabilityMatrix => ({
  write_confined: false, network_none: false, cpu_limit: false, memory_limit: false, pids_limit: false, ledger_readonly: false,
});
export const dockerCapabilities = (): CapabilityMatrix => ({
  write_confined: true, network_none: true, cpu_limit: true, memory_limit: true, pids_limit: true, ledger_readonly: true,
});
export const effectiveRequirements = (requirements: EnvironmentRequirements, backend: string): EnvironmentRequirements => {
  if (backend === "host") return { ...requirements };
  const cpu = Number(process.env.GROUNDS_DOCKER_CPU ?? 2);
  const memory = process.env.GROUNDS_DOCKER_MEMORY ?? "2g";
  const pids = Number(process.env.GROUNDS_DOCKER_PIDS ?? 256);
  const result = { cpu, memory, pids, network: "allowed" as const, workspace_write: "confined" as const, ...requirements };
  if (!Number.isInteger(result.cpu) || result.cpu < 1 || result.cpu > 256 || !/^[1-9][0-9]{0,4}[mg]$/.test(result.memory) || !Number.isInteger(result.pids) || result.pids < 16 || result.pids > 65536)
    throw new DomainError("ENVIRONMENT_CAPABILITY_UNSUPPORTED", "invalid effective Docker resource limits", false, { unmet: ["cpu", "memory", "pids"] });
  return result;
};
