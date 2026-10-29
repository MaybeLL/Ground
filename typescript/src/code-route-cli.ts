import { resolve } from "node:path";
import { closeSync, constants, openSync } from "node:fs";
import type { ParsedArgs, CLIIO } from "./cli.js";
import type { Attribution } from "./domain.js";
import type { Store } from "./store-types.js";
import { isUUIDv7 } from "./identity.js";
import { validation } from "./errors.js";
import { safeReadOpened } from "./runtime-files.js";
import { CodeRouteExecutions, validateExecutionStart } from "./code-route-execution.js";
import { DockerRouteEngine } from "./code-route-docker.js";
import { CodeRouteController } from "./code-route-controller.js";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { deriveLocalGitArtifact } from "./git-artifact-local.js";

export const codeExecutionCommands = {
  "execution-start": { options: ["config", "file", "operation-id", "agent-id", "agent-name"], positions: 3,
    description: "Start an admitted route once: ROUTE --file JSON {image|environment_revision_id|environment_default:true,argv,mode?}; fixed local image or Repo environment revision, default read-only-diagnostic; development needs execution-serve; retry with the same operation ID and inputs" },
  "execution-show": { options: ["config", "refresh"], positions: 4,
    description: "Read the saved execution: ROUTE EXECUTION; --refresh observes the exact live container and records its exit code; saved state alone is not live proof" },
  "execution-serve": { options: ["config"], positions: 4,
    description: "Run or recover the foreground development controller: ROUTE EXECUTION; SIGINT/SIGTERM drains an in-flight request then stops; unknown effects retain ownership" },
  "execution-stop": { options: ["config"], positions: 4,
    description: "Stop the exact owned execution: ROUTE EXECUTION; unresolved Git effects must be recovered with execution-serve; never force-release ownership" },
} as const;

export async function executeCodeExecution(input: { action: keyof typeof codeExecutionCommands; args: ParsedArgs;
  store: Store; cwd: string; io: CLIIO; attribution: () => Attribution; operationID: () => string }) {
  const { action, args, store } = input;
  const route_id = args.positionals[2]!;
  if (!isUUIDv7(route_id)) throw validation("route_id", "requires UUIDv7");
  const bindRouteArtifacts = async () => {
    const route = await new CodeWorkspaceRoutes(store).show(route_id);
    // This command's store resolves refinement artifacts from its selected route.
    store.setGitArtifactResolver?.(ref => {
      if (!ref.git_artifact) throw validation("artifact", "Git artifact metadata required");
      return deriveLocalGitArtifact(route.path, ref.git_artifact.binding);
    });
  };
  const engine = new DockerRouteEngine(), service = new CodeRouteExecutions(store, engine);
  const base = { result_type: "grounds.result.code-execution/v1", command: `code-workspace.${action}` };
  if (action === "execution-start") {
    if (typeof args.values.file !== "string" || !args.values.file) throw validation("file", "requires a bounded JSON start file");
    let content: any;
    try {
      const fd = openSync(resolve(input.cwd, args.values.file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { content = JSON.parse(safeReadOpened(fd, 1024 * 1024).toString("utf8")); }
      finally { closeSync(fd); }
    }
    catch { throw validation("file", "cannot read a bounded regular JSON start file"); }
    if (!content || typeof content !== "object" || Array.isArray(content)
      || Object.keys(content).some(key => !["image", "environment_revision_id", "environment_default", "argv", "mode"].includes(key)))
      throw validation("file", "only image, environment_revision_id or environment_default, argv and optional mode are accepted");
    const request = { route_id, operation_id: input.operationID(),
      attribution: input.attribution(), argv: content.argv,
      ...(content.image !== undefined ? { image: content.image } : {}),
      ...(content.environment_revision_id !== undefined ? { environment_revision_id: content.environment_revision_id } : {}),
      ...(content.environment_default !== undefined ? { environment_default: content.environment_default } : {}),
      ...(content.mode !== undefined ? { mode: content.mode } : {}) };
    validateExecutionStart(request);
    await bindRouteArtifacts();
    return { ...base, execution: await service.start(request) };
  }
  const execution_id = args.positionals[3]!;
  if (!isUUIDv7(execution_id)) throw validation("execution_id", "requires UUIDv7");
  const ref = { route_id, execution_id };
  if (action === "execution-show") {
    const execution = await service.show(ref);
    if (String(args.values.refresh).toLowerCase() === "true" && execution.state !== "stopped") {
      const current = await service.observe(ref);
      return { ...base, execution: current.execution, observation: current.status };
    }
    return { ...base, execution };
  }
  if (action === "execution-stop") return { ...base, execution: await service.stop(ref) };
  await bindRouteArtifacts();
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  const signal = input.io.signal ?? cancellation.signal;
  // Keep process handlers scoped to this foreground command. SIGKILL still leaves
  // the journal and execution owner available to a later explicit serve.
  if (!input.io.signal) { process.on("SIGINT", abort); process.on("SIGTERM", abort); }
  try {
    (input.io.stderr ?? (line => process.stderr.write(line + "\n")))(`execution_id: ${execution_id}`);
    const outcome = await new CodeRouteController(store, engine).serve(ref, { signal });
    return { ...base, execution: await service.show(ref), outcome };
  } finally {
    if (!input.io.signal) { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
  }
}

/** A successful control reply can still report an unsuccessful container process. */
export function codeExecutionExitCode(data: unknown): number {
  const control = data as { result_type?: string; command?: string; check?: { state: string } } | undefined;
  if (control?.result_type === "grounds.result.environment-control/v1" && control.command === "code-workspace.environment-check")
    return control.check?.state === "passed" ? 0 : 1;
  const development = data as { result_type?: string; command?: string; preparation?: { state: string; environment_revision_id?: string } } | undefined;
  if (development?.result_type === "grounds.result.development-image/v1" && development.command === "code-workspace.recipe-prepare")
    return development.preparation?.state === "ready" && development.preparation.environment_revision_id ? 0 : 1;
  const preparation = data as { result_type?: string; command?: string; preparation?: { state: string } } | undefined;
  if (preparation?.result_type === "grounds.result.repository-image/v1" && preparation.command === "code-workspace.image-prepare")
    return preparation.preparation?.state === "ready" ? 0 : 1;
  const result = data as { result_type?: string; outcome?: { reason: string; exit_code?: number } } | undefined;
  if (result?.result_type !== "grounds.result.code-execution/v1" || !result.outcome) return 0;
  if (result.outcome.reason === "cancelled") return 130;
  return result.outcome.reason === "exited" && result.outcome.exit_code !== 0 ? 1 : 0;
}
