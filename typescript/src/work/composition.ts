// Composition root: reads configuration, creates adapters and injects them
// into the application services and drivers. The only place allowed to import
// every layer.
import { createHash } from "node:crypto";
import { newUUIDv7 } from "../identity.js";
import type { SQLStore } from "../sql-store.js";
import { GitTagArchive, GitWorktrees, SqlWorkUnitOfWork } from "./adapters/index.js";
import { DurableSandboxLauncher } from "./adapters/devcontainer/launch.js";
import { pinnedConfig } from "./adapters/devcontainer/config.js";
import { DevcontainerRuntime } from "./adapters/devcontainer/runtime.js";
import { ManagedWorkspaces } from "./adapters/devcontainer/workspace.js";
import { SandboxLifecycle } from "./application/sandbox-lifecycle.js";
import { SandboxRecovery } from "./application/sandbox-recovery.js";
import { SandboxProvisioning } from "./application/sandbox-provisioning.js";
import { EnvironmentDefinitions } from "./application/environment-definitions.js";
import { ProviderTraces } from "./application/provider-traces.js";
import { ProviderTraceCapture } from "./adapters/providers/trace-capture.js";
import { commandLineProviders } from "./adapters/providers/command-line.js";
import { ManagedWorkers } from "./application/managed-workers.js";
import { ManagedTaskDriver } from "./driver/managed-task.js";
import { ContainerAgentProcess } from "./adapters/devcontainer/managed-process.js";
import { AgentDefinitions } from "./application/agent-definitions.js";
import { RuleDefinitions } from "./application/rule-definitions.js";
import { EvaluationSuites } from "./application/evaluation-suites.js";
import { ArchiveRepairs } from "./application/archive-repairs.js";
import { CodeDelivery, Grading, TaskDefinitions, TaskExecution, type WorkApplication } from "./application/index.js";

/** The work model over a ledger, with the real clock, identifiers, hash and git. */
export function composeWork(store: SQLStore): WorkApplication & {driver:ManagedTaskDriver} {
  const units = new SqlWorkUnitOfWork(store);
  const archive = new GitTagArchive();
  const shared = { units, clock: { now: () => new Date().toISOString() }, ids: { next: newUUIDv7 }, hash: (text: string) => createHash("sha256").update(text).digest("hex") };
  const context = { units, hash: shared.hash, now: shared.clock.now, newId: newUUIDv7 };
  const runtime = new DevcontainerRuntime(), ledgerId = async () => (await store.inspect()).database_id;
  const lifecycle = new SandboxLifecycle({ ...context, runtime, ledgerId });
  const workspaces = new ManagedWorkspaces();
  const managed = { ...context, lifecycle, runtime, ledgerId, workspaces, launcher:new DurableSandboxLauncher(workspaces) };
  const recovery = new SandboxRecovery(managed);
  const agents = new AgentDefinitions(context,commandLineProviders,archive);
  const exec = new TaskExecution({ ...shared, agents, receipts: archive, lifecycle, recovery });
  const repairs = new ArchiveRepairs({ ...shared, archive });
  const suites = new EvaluationSuites({ units, repairs, archive, hash: shared.hash, now: shared.clock.now, newId: newUUIDv7,
    capture: bytes => ({ digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"), base64: Buffer.from(bytes).toString("base64") }) });
  const rules = new RuleDefinitions(context);
  const environments = new EnvironmentDefinitions(context, pinnedConfig);
  const delivery = new CodeDelivery({ units, exec, archive, repairs, worktrees: new GitWorktrees() });
  const sandboxes = new SandboxProvisioning({ ...managed, delivery }, recovery);
  const workers=new ManagedWorkers({...context,lifecycle});
  const driver=new ManagedTaskDriver({workers,sandboxes,lifecycle,ledgerId,process:new ContainerAgentProcess(runtime,workspaces,archive)});
  return { workers,driver,agents, traces:new ProviderTraces(context,new ProviderTraceCapture()), lifecycle, sandboxes, environments, rules, suites, repairs, tasks: new TaskDefinitions(shared), exec, grading: new Grading(shared), delivery };
}
