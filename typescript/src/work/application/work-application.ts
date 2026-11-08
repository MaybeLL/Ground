import type { CodeDelivery } from "./code-delivery.js";
import type { Grading } from "./grading.js";
import type { TaskDefinitions } from "./task-definitions.js";
import type { TaskExecution } from "./task-execution.js";

/** Everything the command line can ask of the work model. */
export interface WorkApplication {
  readonly evaluators:import("./managed-evaluators.js").ManagedEvaluators;
  readonly artifacts:import("./artifacts.js").Artifacts;
  readonly experimentResults:import("./experiment-results.js").ExperimentResults;
  readonly experiments:import("./experiment-plans.js").ExperimentPlans;
  readonly members:import("./experiment-members.js").ExperimentMembers;
  readonly tests: import("./test-execution.js").TestExecution;
  readonly traces: import("./provider-traces.js").ProviderTraces;
  readonly workers:import("./managed-workers.js").ManagedWorkers;
  readonly agents: import("./agent-definitions.js").AgentDefinitions;
  readonly rules: import("./rule-definitions.js").RuleDefinitions;
  readonly environments: import("./environment-definitions.js").EnvironmentDefinitions;
  readonly lifecycle: import("./sandbox-lifecycle.js").SandboxLifecycle;
  readonly sandboxes: import("./sandbox-provisioning.js").SandboxProvisioning;
  readonly suites: import("./evaluation-suites.js").EvaluationSuites;
  readonly repairs: import("./archive-repairs.js").ArchiveRepairs;
  readonly tasks: TaskDefinitions;
  readonly exec: TaskExecution;
  readonly grading: Grading;
  readonly delivery: CodeDelivery;
}
