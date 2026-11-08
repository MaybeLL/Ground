import type { CodeDelivery } from "./code-delivery.js";
import type { Grading } from "./grading.js";
import type { TaskDefinitions } from "./task-definitions.js";
import type { TaskExecution } from "./task-execution.js";

/** Everything the command line can ask of the work model. */
export interface WorkApplication {
  readonly rules: import("./rule-definitions.js").RuleDefinitions;
  readonly suites: import("./evaluation-suites.js").EvaluationSuites;
  readonly repairs: import("./archive-repairs.js").ArchiveRepairs;
  readonly tasks: TaskDefinitions;
  readonly exec: TaskExecution;
  readonly grading: Grading;
  readonly delivery: CodeDelivery;
}
