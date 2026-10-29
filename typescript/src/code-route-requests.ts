import { closeSync, constants, existsSync, openSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodeRouteExecutions, type RouteEngine, type RouteExecution } from "./code-route-execution.js";
import { assertChannelIdle, routeChannel } from "./code-route-channel.js";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { readRouteControl } from "./code-route-fence.js";
import { sha256 } from "./canonical-json.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { atomicPrivateWrite, safeRead, safeReadOpened, withRuntimeLock } from "./runtime-files.js";
import type { RouteGitResult, RouteGitSnapshot } from "./code-route-git.js";
import type { Store } from "./store-types.js";

interface ExecutionRef { route_id: string; execution_id: string }
interface Request {
  request_id: string; execution_id: string; action: "stage" | "unstage" | "commit";
  paths?: string[]; message?: string; author?: { name: string; email: string };
}
export type RouteRequestReceipt = { request_id: string; execution_id: string } & (
  { state: "completed"; result: RouteGitResult } | { state: "aborted" }
  | { state: "rejected"; error: RequestRejection });
interface RequestRejection { code: "VALIDATION_ERROR"; message: string }
interface Journal {
  format: "grounds.code-route-request/v1"; execution_id: string; generation: number;
  request: Request; digest: string; pause_id: string; git_id: string;
  snapshot?: RouteGitSnapshot; result?: RouteGitResult; receipt?: RouteRequestReceipt;
  apply_started?: boolean; aborted?: boolean;
  rejection?: RequestRejection;
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
function validateRequest(value: any, executionId: string): Request {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isUUIDv7(value.request_id)
    || value.execution_id !== executionId || !["stage", "unstage", "commit"].includes(value.action)
    || Object.keys(value).some(key => !["request_id", "execution_id", "action",
      ...(value.action === "commit" ? ["message", "author"] : ["paths"])].includes(key)))
    throw validation("request", "requires a fixed action bound to this execution");
  if (value.action !== "commit") {
    if (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 128 || new Set(value.paths).size !== value.paths.length
      || value.paths.some((path: unknown) => typeof path !== "string" || path.length > 1024 || !path || /[\\\x00-\x1f\x7f:]/.test(path)
        || path.split("/").some(part => !part || part === "." || part === ".." || /^\.git$/i.test(part))))
      throw validation("paths", "requires bounded distinct relative file paths");
  } else if (typeof value.message !== "string" || !value.message.trim() || value.message.length > 65536 || value.message.includes("\0")
    || !value.author || typeof value.author !== "object" || Array.isArray(value.author)
    || Object.keys(value.author).some(key => !["name", "email"].includes(key))
    || [value.author.name, value.author.email].some(item => typeof item !== "string" || !item.trim() || item.length > 256 || /[<>\x00-\x1f\x7f]/.test(item)))
    throw validation("commit", "requires a bounded message and author");
  return value;
}

/** Host controller for a mount-scoped mailbox, not a network endpoint accepting caller route IDs.
 * Every process in the same container has the same capability. Attribution comes from start(). */
export class CodeRouteRequests {
  private readonly executions: CodeRouteExecutions;
  constructor(private readonly store: Store, private readonly engine: RouteEngine) {
    this.executions = new CodeRouteExecutions(store, engine);
  }
  private async current(ref: ExecutionRef): Promise<RouteExecution> {
    const run = await this.executions.show(ref), route = await new CodeWorkspaceRoutes(this.store).show(ref.route_id);
    const control = readRouteControl(route);
    if (run.mode !== "development" || control.execution_id !== run.execution_id || control.generation !== run.generation
      || !["running", "pausing", "paused", "resuming"].includes(run.state)
      || await this.engine.identity() !== run.engine_id || await this.engine.find(run) !== run.container_id)
      conflict("Mailbox no longer belongs to an active development execution");
    return run;
  }
  /** Trusted host discovery. No host paths are included in container receipts. */
  async transport(ref: ExecutionRef) { return routeChannel(await this.current(ref)); }

  async process(input: ExecutionRef): Promise<RouteRequestReceipt> { return (await this.dispatch(input))!; }
  /** Recovery uses the host-pinned request, even if the untrusted inbox was replaced/deleted. */
  async recover(input: ExecutionRef): Promise<RouteRequestReceipt> { return (await this.dispatch(input, "recover"))!; }
  /** Host-only cancellation. Applied or uncertain Git effects cannot be discarded. */
  async abort(input: ExecutionRef): Promise<RouteRequestReceipt> { return (await this.dispatch(input, "abort"))!; }
  /** One bounded iteration. Recover accepted input before reading any new untrusted request. */
  async poll(input: ExecutionRef): Promise<RouteRequestReceipt | undefined> { return this.dispatch(input, "poll"); }

  private async dispatch(input: ExecutionRef, recovery?: "recover" | "abort" | "poll"): Promise<RouteRequestReceipt | undefined> {
    const ref = structuredClone(input), initial = await this.current(ref);
    const channel = routeChannel(initial), runtime = join(resolve(initial.code_path, "../../../.."), "runtime");
    return withRuntimeLock(runtime, `code-channel:${initial.execution_id}`, async () => {
      const run = await this.current(ref);
      const pending = join(channel.root, "pending.json");
      let request: Request;
      if (recovery === "recover" || recovery === "abort" || (recovery === "poll" && existsSync(pending))) {
        const active = JSON.parse(safeRead(pending, 1024).toString());
        if (!isUUIDv7(active.request_id)) conflict("Invalid pending container request");
        const saved = JSON.parse(safeRead(join(channel.root, "requests", `${active.request_id}.json`)).toString()) as Journal;
        request = validateRequest(saved.request, run.execution_id);
        if (request.request_id !== active.request_id) conflict("Pending request identity changed");
      } else {
        // NONBLOCK prevents a malicious FIFO from hanging before fstat rejects it.
        let fd: number;
        try { fd = openSync(join(channel.inbox, "request.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error: any) { if (recovery === "poll" && error.code === "ENOENT") return undefined; throw error; }
        try { request = validateRequest(JSON.parse(safeReadOpened(fd, 192 * 1024).toString("utf8")), run.execution_id); }
        finally { closeSync(fd); }
      }
      const path = join(channel.root, "requests", `${request.request_id}.json`), digest = sha256(request);
      let journal: Journal;
      if (existsSync(path)) {
        journal = JSON.parse(safeRead(path).toString());
        if (journal.format !== "grounds.code-route-request/v1" || journal.execution_id !== run.execution_id
          || journal.generation !== run.generation || journal.digest !== digest || sha256(journal.request) !== digest)
          conflict("Request ID was reused with different inputs");
      } else {
        journal = { format: "grounds.code-route-request/v1", execution_id: run.execution_id, generation: run.generation,
          request, digest, pause_id: newUUIDv7(), git_id: newUUIDv7() };
      }
      if (recovery === "abort" && (journal.result || journal.receipt?.state === "completed"))
        conflict("Completed Git effects must be recovered, not aborted");
      if (recovery === "poll" && journal.receipt && !existsSync(pending)) {
        const response = join(channel.outbox, "response.json");
        if (existsSync(response) && sha256(JSON.parse(safeRead(response, 16 * 1024).toString())) === sha256(journal.receipt)) return undefined;
      }
      await withRuntimeLock(runtime, `code-route:${run.route_id}`, async () => {
        const current = await this.current(ref);
        assertChannelIdle(current, request.request_id);
        if (current.pause_id && current.pause_id !== journal.pause_id)
          conflict("Another host pause owns this execution");
        atomicPrivateWrite(path, JSON.stringify(journal));
        atomicPrivateWrite(pending, JSON.stringify({ request_id: request.request_id }));
      });
      const persist = () => atomicPrivateWrite(path, JSON.stringify(journal));
      if (!journal.receipt) {
        const window = { ...ref, operation_id: journal.pause_id, attribution: run.attribution, channel_request_id: request.request_id };
        const writer = this.executions.git(window);
        if (!journal.result && !journal.aborted) {
          await this.executions.pause(window);
          if (recovery !== "abort" && !journal.rejection) {
            try {
              if (!journal.snapshot) {
                journal.snapshot = await writer.snapshot(request.action === "stage" ? request.paths! : []);
                persist();
              }
              journal.apply_started = true;
              persist();
              journal.result = await writer.apply({ operation_id: journal.git_id, action: request.action,
                snapshot: journal.snapshot, attribution: run.attribution,
                ...(request.action === "unstage" ? { paths: request.paths } : request.action === "commit" ? { message: request.message, author: request.author } : {}) });
              persist();
            } catch (error) {
              if (recovery !== "poll" || !(error instanceof DomainError) || error.code !== "VALIDATION_ERROR") throw error;
              const hints: Record<string, string> = {
                attributes: "Unsupported Git attributes: external filters and encodings are not supported.",
                commit: "Commit rejected: check the staged changes and commit metadata.",
                index: "Unsupported Git index state; host intervention is required.",
                path: "Unsupported file path or file type.",
                snapshot: "The requested snapshot exceeds its limits.",
              };
              const field = String(error.details.field);
              journal.rejection = { code: "VALIDATION_ERROR", message: Object.hasOwn(hints, field) ? hints[field]! : "Managed Git input was rejected." };
              persist();
            }
          }
          if (recovery === "abort" || journal.rejection) {
            if (journal.apply_started) await writer.abort({ operation_id: journal.git_id, attribution: run.attribution,
              unapplied_request: { operation_id: journal.git_id, action: request.action,
                snapshot: journal.snapshot!, attribution: run.attribution,
                ...(request.action === "unstage" ? { paths: request.paths } : request.action === "commit" ? { message: request.message, author: request.author } : {}) } });
            journal.aborted = true;
            persist();
          }
        }
        await this.executions.resume(window);
        journal.receipt = { request_id: request.request_id, execution_id: run.execution_id,
          ...(journal.rejection ? { state: "rejected" as const, error: journal.rejection }
            : journal.aborted ? { state: "aborted" as const } : { state: "completed" as const, result: journal.result! }) };
        persist();
      }
      atomicPrivateWrite(join(channel.outbox, "response.json"), JSON.stringify(journal.receipt));
      unlinkSync(pending);
      return journal.receipt;
    });
  }
}
