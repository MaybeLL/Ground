import type { ParsedArgs } from "./cli.js";
import type { Attribution } from "./domain.js";
import type { Store } from "./store-types.js";
import { validation } from "./errors.js";
import { RepositoryEnvironments } from "./repository-environment.js";
import { RepositoryEnvironmentChecks } from "./repository-environment-check.js";
import { DockerRouteEngine } from "./code-route-docker.js";

export const environmentControlCommands = {
  "environment-check": { options: ["config", "revision", "operation-id", "agent-id", "agent-name"],
    description: "Check fixed Git/Python/service readiness on an admitted ROUTE --revision REVISION; code is read-only; same operation ID resumes; pass requires confirmed stop, not business acceptance" },
  "environment-check-show": { options: ["config"],
    description: "Read CHECK_ID historical readiness and recovery state; it does not prove present availability" },
  "environment-set-default": { options: ["config", "check", "expected-version", "operation-id", "agent-id", "agent-name"],
    description: "Explicitly select a checked version for REPO --check CHECK_ID --expected-version N (0 initially); existing executions stay pinned" },
  "environment-default": { options: ["config"],
    description: "Read REPO default version and its original successful check; no implicit latest-version fallback" },
} as const;

export async function executeEnvironmentControl(input: { action: keyof typeof environmentControlCommands; args: ParsedArgs;
  store: Store; attribution: () => Attribution; operationID: () => string }) {
  const { action, args, store } = input, id = args.positionals[2]!;
  const required = (name: string) => {
    const value = args.values[name];
    if (typeof value !== "string" || !value) throw validation(name, "requires a value");
    return value;
  };
  const base = { result_type: "grounds.result.environment-control/v1", command: `code-workspace.${action}` };
  const environments = new RepositoryEnvironments(store);
  if (action === "environment-default") return { ...base, default: await environments.default(id) };
  if (action === "environment-set-default") {
    const version = required("expected-version");
    if (!/^(0|[1-9][0-9]*)$/.test(version)) throw validation("expected-version", "requires a nonnegative integer");
    return { ...base, default: await environments.setDefault({ operation_id: input.operationID(), repository_id: id,
      check_id: required("check"), expected_version: Number(version), attribution: input.attribution() }) };
  }
  const checks = new RepositoryEnvironmentChecks(store, new DockerRouteEngine());
  return { ...base, check: action === "environment-check-show" ? await checks.show(id)
    : await checks.check({ operation_id: input.operationID(), route_id: id, environment_revision_id: required("revision"), attribution: input.attribution() }) };
}
