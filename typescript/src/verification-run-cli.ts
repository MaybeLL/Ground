import { resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import type { Store } from "./store-types.js";
import type { Attribution } from "./domain.js";
import { validation, DomainError } from "./errors.js";
import { isSha256, isUUIDv7 } from "./identity.js";
import { Module } from "./module.js";
import { ReviewSessions, writeMaterial, type ReviewRole } from "./review-session.js";
import { materializeCandidateWorktree, type ReviewWorktreeMarker } from "./git.js";
import { commonRepositoryRoot } from "./dev-worktree.js";
import { verificationTemplateFromBlindContext } from "./verification-handoff.js";
import { qualityTemplateFromBlindContext, QUALITY_CONTEXT_FORMAT, parseVerificationRole } from "./quality-review.js";
import { commandDigest, COORDINATOR_STAGES, ENTRY_SPANNED_STAGES, RUN_STAGE_STATES, RUN_STAGES, summarize, runData, VerificationRuns, type RunStage, type StageState, type VerificationRunData, type VerificationRunRole } from "./verification-run.js";
import type { RuntimeRecord } from "./runtime-record.js";

/**
 * `grounds verification run ...` is the coordinator's standard preparation and
 * observation entry for one round of independent verification. It records the
 * run, times its own coordination steps, and derives a next step from the
 * durable record. It never submits a Verification and never replaces the
 * signature or coverage checks in `verification submit`.
 */

interface SubCommand { options: string[]; required?: string[]; subject: "candidate" | "run" }
const commands: Record<string, SubCommand> = {
  start: { subject: "candidate", options: ["config", "candidate", "role", "agent-id", "agent-name"], required: [] },
  show: { subject: "run", options: ["config", "run"], required: [] },
  list: { subject: "candidate", options: ["config", "candidate", "role", "review-session"], required: [] },
  stage: { subject: "run", options: ["config", "run", "stage", "state", "reason"], required: ["stage", "state"] },
  command: { subject: "run", options: ["config", "run", "stage", "entry", "started-at", "ended-at", "exit-code", "state"], required: ["stage", "entry", "started-at", "ended-at"] },
  environment: { subject: "run", options: ["config", "run", "identity", "asset", "lease", "hit", "reason", "state"], required: ["identity", "hit", "reason"] },
  freeze: { subject: "run", options: ["config", "run", "independent-digest", "copy-path"], required: ["independent-digest"] },
  handoff: { subject: "run", options: ["config", "run", "report-digest", "state", "path"], required: ["report-digest"] },
  submit: { subject: "run", options: ["config", "run", "state", "operation-id", "verification"], required: ["state", "operation-id"] },
};

const has = (args: ParsedArgs, key: string): boolean => args.values[key] !== undefined;
const text = (args: ParsedArgs, key: string, fallback = ""): string => {
  const raw = args.values[key];
  if (raw === undefined) return fallback;
  return Array.isArray(raw) ? String(raw[raw.length - 1]) : typeof raw === "boolean" ? String(raw) : String(raw);
};
const need = (args: ParsedArgs, key: string): string => { const v = text(args, key); if (!v) throw validation(key, "is required"); return v; };
const flag = (args: ParsedArgs, key: string): boolean => {
  const raw = text(args, key).toLowerCase();
  if (raw !== "true" && raw !== "false") throw validation(key, "must be true or false");
  return raw === "true";
};
/** The subject ID is positional, or the matching named option; both at once is ambiguous. */
const subjectId = (args: ParsedArgs, key: "candidate" | "run"): string => {
  const positional = args.positionals[3];
  const named = has(args, key) ? text(args, key) : undefined;
  if (positional !== undefined && named !== undefined) throw validation(key, `use either positional ${key} ID or --${key}, not both`);
  const id = positional ?? named ?? "";
  if (!isUUIDv7(id)) throw validation(key, "must be a lowercase UUIDv7");
  return id;
};

export const verificationRunSubcommand = (args: ParsedArgs): string => args.positionals[2] ?? "";
export const isVerificationRunCommand = (args: ParsedArgs): boolean => args.positionals[0] === "verification" && args.positionals[1] === "run";

export function verificationRunHelp(): string {
  const lines = ["grounds verification run <操作> [ID]", "", "协调者标准准备与观测入口：记录单轮独立验证的阶段、耗时与交接状态。不提交 Verification，也不替代签名与覆盖检查。", "", "可用操作:"];
  const docs: Record<string, string> = {
    start: "准备一轮验证：物化审阅工作树、写入盲验上下文与报告骨架，并开始记录运行",
    show: "显示运行记录的阶段耗时摘要与下一步",
    list: "列出某 Candidate 的运行记录",
    stage: "协调者阶段（blind、reconcile、wait）的进入/结束；入口自闭环阶段（prepare、freeze、handoff、submit）只能强制 failed/unknown",
    command: "记录一条经入口执行的命令（起止、终态、所属阶段）",
    environment: "记录本轮环境/资产/租用身份与命中原因",
    freeze: "固定盲验独立判断的摘要（对照前不可更改）",
    handoff: "记录签名交接状态与报告摘要",
    submit: "记录提交状态与幂等身份（不执行提交）",
  };
  for (const [name, description] of Object.entries(docs)) lines.push(`  ${("run " + name).padEnd(20)} ${description}`);
  lines.push("", "继续查看: grounds verification run <操作> --help");
  return lines.join("\n");
}

/** Returns true when the caller only asked for help; throws on invalid arguments otherwise. */
export function validateVerificationRunArgs(args: ParsedArgs): boolean {
  const name = verificationRunSubcommand(args);
  if (name === "help") return true;
  const command = commands[name];
  if (!command) throw validation("verification run", `expected ${Object.keys(commands).join(", ")}`);
  for (const [key, raw] of Object.entries(args.values)) {
    if (key === "json" || key === "cwd" || key === "help") continue;
    if (!command.options.includes(key)) throw validation(`--${key}`, `is not valid for verification run ${name}`);
    if (Array.isArray(raw)) throw validation(`--${key}`, "must be supplied at most once");
  }
  for (const key of command.required ?? []) if (!text(args, key)) throw validation(key, "is required");
  if (args.positionals.length !== 4) throw validation("verification run", `${name} expects one ${command.subject} ID`);
  subjectId(args, command.subject);
  return false;
}

/** A named option that must be a UUIDv7, e.g. --operation-id or --verification. */
const uuidOption = (args: ParsedArgs, key: string, field: string): string => {
  const value = need(args, key);
  if (!isUUIDv7(value)) throw validation(field, "must be a lowercase UUIDv7");
  return value;
};

const stageValue = (raw: string): RunStage => { if (!RUN_STAGES.includes(raw as RunStage)) throw validation("stage", `must be one of ${RUN_STAGES.join(", ")}`); return raw as RunStage; };
const stateValue = (raw: string): StageState => { if (!RUN_STAGE_STATES.includes(raw as StageState)) throw validation("state", `must be one of ${RUN_STAGE_STATES.join(", ")}`); return raw as StageState; };

const observation = (entry: string, argv: readonly string[], stage: RunStage, state: "succeeded" | "failed" | "unknown", startedIso: string) => ({
  entry,
  argv_digest: commandDigest(argv),
  started_at: startedIso,
  ended_at: new Date().toISOString(),
  state,
  stage,
});

export interface VerificationRunDeps {
  store: Store;
  cwd: string;
  databaseId: string;
  attribution: () => Attribution;
  /** Validates that the current clone matches the Candidate's Repository; supplied by the CLI to share one check. */
  validateClone: (path: string, repositoryId: string) => Promise<void>;
}

export function runNextStep(data: VerificationRunData): string {
  const last = (stage: RunStage) => { const attempts = data.stages[stage]; return attempts && attempts.length ? attempts[attempts.length - 1] : undefined; };
  if (data.submit?.state === "confirmed") return "Verification submitted; review the recorded result. The run record is not a second verdict.";
  if (data.submit?.state === "unknown") return "Submit result is unknown; reconcile with the public interface using the same operation ID before retrying.";
  if (last("prepare")?.state === "failed") return "Preparation failed; fix the reported gap and start a new run. Do not mark an incomplete material set ready.";
  const open = RUN_STAGES.find((stage) => last(stage)?.state === "running");
  if (open) return `Stage ${open} is running; close it with: verification run stage RUN --stage ${open} --state succeeded|failed|blocked|skipped|unknown`;
  if (last("blind")?.state !== "succeeded") return "Complete the blind assessment, then record: verification run stage RUN --stage blind --state succeeded";
  if (!data.freeze) return "Freeze the blind independent part before reconciliation: verification run freeze RUN --independent-digest sha256:...";
  if (last("reconcile")?.state !== "succeeded") return "Run the reconcile phase with the same verifier, then record it as succeeded.";
  if (!data.handoff) return "Sign the handoff, then record it: verification run handoff RUN --report-digest sha256:... --state signed";
  return "Submit through the public interface, then record: verification run submit RUN --state confirmed --operation-id UUID --verification VERIFICATION_ID";
}

export async function executeVerificationRun(args: ParsedArgs, deps: VerificationRunDeps): Promise<unknown> {
  const name = verificationRunSubcommand(args);
  if (name === "help") return { result_type: "patchledger.result.help/v1", command: "help", usage: verificationRunHelp() };
  const runs = new VerificationRuns(deps.store);
  const module = new Module(deps.store);
  const role = (): VerificationRunRole => parseVerificationRole(text(args, "role", "contract")) as VerificationRunRole;
  const since = new Date().toISOString();
  const emit = (id: string, command: string, row: RuntimeRecord) => {
    const data = runData(row);
    return { result_type: "patchledger.result.verification-run/v1", command, ...summarize(id, row), next_step: runNextStep(data), retained: { review_worktree: data.review_worktree, ...(data.freeze?.copy_path ? { frozen_copy: data.freeze.copy_path } : {}), ...(data.handoff?.path ? { handoff: data.handoff.path } : {}) } };
  };

  if (name === "start") {
    const candidateId = subjectId(args, "candidate");
    const runRole = role();
    const actor = deps.attribution();
    const materialization = await module.loadCandidateMaterialization(candidateId);
    await deps.validateClone(deps.cwd, materialization.repository_id);
    const sessions = new ReviewSessions(commonRepositoryRoot(deps.cwd));
    const session = sessions.allocate(candidateId);
    try {
      const marker: ReviewWorktreeMarker = { format: "patchledger.review-worktree/v1", database_id: deps.databaseId, candidate_id: materialization.candidate_id, repository_id: materialization.repository_id, baseline_oid: materialization.baseline.git_oid, result_tree_oid: materialization.result_tree_oid, patch_digest: materialization.patch_digest };
      materializeCandidateWorktree({ source_path: deps.cwd, target_path: session.worktree, mode: "review", source_commit: materialization.source?.commit, baseline_oid: materialization.baseline.git_oid, patch: materialization.patch, expected_tree_oid: materialization.result_tree_oid, review_marker: marker });
      const context = (await module.verificationContext(candidateId, "blind", runRole as ReviewRole)).context as { format: string; blind_context_digest: string; result_tree_oid: string };
      // Write all material before the ledger row: a failed material write then leaves no orphaned run,
      // only a session directory that the catch below removes.
      const contextPath = writeMaterial(sessions.contextPath(candidateId, session.session_id, runRole as ReviewRole, "blind"), context);
      const template = context.format === QUALITY_CONTEXT_FORMAT ? qualityTemplateFromBlindContext(context) : verificationTemplateFromBlindContext(context);
      const reportPath = writeMaterial(sessions.materialPath(candidateId, session.session_id, "report-skeleton", runRole as ReviewRole), template.report);
      const row = await runs.begin({ candidate_id: candidateId, result_tree_oid: context.result_tree_oid, blind_context_digest: context.blind_context_digest, role: runRole, review_session_id: session.session_id, review_worktree: session.worktree, attribution: actor, at: since });
      const closed = await runs.stage(row.id, "prepare", "succeeded");
      return { ...emit(row.id, "verification.run.start", closed.row), candidate_id: candidateId, role: runRole, review_session_id: session.session_id, paths: { review_worktree: session.worktree, blind_context: contextPath, report_skeleton: reportPath } };
    } catch (error) {
      sessions.discard(session.directory);
      throw error;
    }
  }

  if (name === "show") return emit(subjectId(args, "run"), "verification.run.show", await runs.show(subjectId(args, "run")));

  if (name === "list") {
    const candidateId = subjectId(args, "candidate");
    const runRole = has(args, "role") ? role() : undefined;
    const session = text(args, "review-session");
    if (session && !isUUIDv7(session)) throw validation("review_session", "must be a lowercase UUIDv7");
    const rows = await runs.listForCandidate(candidateId);
    const items = rows.map((row) => { const data = runData(row); return { ...summarize(row.id, row), next_step: runNextStep(data), retained: { review_worktree: data.review_worktree, ...(data.freeze?.copy_path ? { frozen_copy: data.freeze.copy_path } : {}), ...(data.handoff?.path ? { handoff: data.handoff.path } : {}) } }; }).filter((item) => (!runRole || item.role === runRole) && (!session || item.review_session_id === session));
    return { result_type: "patchledger.result.verification-run-list/v1", command: "verification.run.list", candidate_id: candidateId, runs: items };
  }

  if (name === "stage") {
    const id = subjectId(args, "run");
    const stage = stageValue(need(args, "stage"));
    const state = stateValue(need(args, "state"));
    // A coordinator stage (blind/reconcile/wait) is entered with --state running and closed with an
    // outcome. An entry-spanned stage (prepare/freeze/handoff/submit) is opened and closed by its own
    // entry, so the coordinator may only force failed/unknown — never running or succeeded.
    if (ENTRY_SPANNED_STAGES.includes(stage) && state !== "failed" && state !== "unknown")
      throw validation("stage", `${stage} is opened and closed by its own entry; only failed or unknown may be recorded directly`);
    const reason = has(args, "reason") ? need(args, "reason") : undefined;
    await runs.stage(id, stage, state, reason);
    const observed = await runs.command(id, stage, observation(`stage:${stage}=${state}`, args.positionals, stage, state === "failed" ? "failed" : "succeeded", since));
    return emit(id, "verification.run.stage", observed.row);
  }

  if (name === "command") {
    const id = subjectId(args, "run");
    const stage = stageValue(need(args, "stage"));
    const entry = need(args, "entry");
    const startedAt = need(args, "started-at"), endedAt = need(args, "ended-at");
    if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt))) throw validation("started-at", "must be ISO timestamps");
    const exitCode = has(args, "exit-code") ? Number(text(args, "exit-code")) : undefined;
    if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) throw validation("exit-code", "must be an integer");
    const state = has(args, "state") ? text(args, "state") : exitCode === undefined ? "succeeded" : exitCode === 0 ? "succeeded" : "failed";
    if (!["succeeded", "failed", "unknown"].includes(state)) throw validation("state", "must be succeeded, failed or unknown");
    const row = await runs.command(id, stage, { entry, argv_digest: commandDigest([entry]), started_at: startedAt, ended_at: endedAt, state: state as "succeeded" | "failed" | "unknown", ...(exitCode !== undefined ? { exit_code: exitCode } : {}) });
    return emit(id, "verification.run.command", row.row);
  }

  if (name === "environment") {
    const id = subjectId(args, "run");
    const state = has(args, "state") ? stateValue(text(args, "state")) : "succeeded";
    await runs.bindEnvironment(id, { identity: need(args, "identity"), ...(has(args, "asset") ? { asset: need(args, "asset") } : {}), ...(has(args, "lease") ? { lease: need(args, "lease") } : {}), hit: flag(args, "hit"), reason: need(args, "reason"), state, recorded_at: new Date().toISOString() });
    const observed = await runs.command(id, "prepare", observation("environment", args.positionals, "prepare", "succeeded", since));
    return emit(id, "verification.run.environment", observed.row);
  }

  if (name === "freeze") {
    const id = subjectId(args, "run");
    const digest = need(args, "independent-digest");
    if (!isSha256(digest)) throw validation("independent-digest", "must be a lowercase sha256 digest");
    const copyPath = has(args, "copy-path") ? resolve(deps.cwd, need(args, "copy-path")) : undefined;
    // The freeze entry opens and closes its own stage; a rejected freeze records the failure.
    await runs.span(id, "freeze", async () => { await runs.freeze(id, digest, copyPath); });
    const observed = await runs.command(id, "freeze", observation("freeze", args.positionals, "freeze", "succeeded", since));
    return emit(id, "verification.run.freeze", observed.row);
  }

  if (name === "handoff") {
    const id = subjectId(args, "run");
    const reportDigest = need(args, "report-digest");
    if (!isSha256(reportDigest)) throw validation("report-digest", "must be a lowercase sha256 digest");
    const state = (has(args, "state") ? text(args, "state") : "signed") as "signed" | "unknown";
    if (state !== "signed" && state !== "unknown") throw validation("state", "must be signed or unknown");
    const path = has(args, "path") ? resolve(deps.cwd, need(args, "path")) : undefined;
    // A signed handoff closes the stage succeeded; an unknown handoff leaves it running for the coordinator.
    if (state === "signed") await runs.span(id, "handoff", async () => { await runs.recordHandoff(id, reportDigest, state, path); });
    else { await runs.ensureStage(id, "handoff"); await runs.recordHandoff(id, reportDigest, state, path); }
    const observed = await runs.command(id, "handoff", observation("handoff", args.positionals, "handoff", state === "signed" ? "succeeded" : "unknown", since));
    return emit(id, "verification.run.handoff", observed.row);
  }

  if (name === "submit") {
    const id = subjectId(args, "run");
    const state = text(args, "state") as "pending" | "confirmed" | "unknown";
    if (!["pending", "confirmed", "unknown"].includes(state)) throw validation("state", "must be pending, confirmed or unknown");
    const operationId = uuidOption(args, "operation-id", "operation_id");
    const verificationId = has(args, "verification") ? uuidOption(args, "verification", "verification_id") : undefined;
    const data = runData(await runs.show(id));
    // A confirmed submit must have a signed handoff; the run layer never bypasses signature or coverage checks.
    if (state === "confirmed" && !data.handoff) throw new DomainError("STATE_CONFLICT", "record a signed handoff before confirming a submit", false, { reason: "handoff_missing" });
    if (state === "confirmed") await runs.span(id, "submit", async () => { await runs.recordSubmit(id, state, operationId, verificationId); });
    else { await runs.ensureStage(id, "submit"); await runs.recordSubmit(id, state, operationId, verificationId); }
    const observed = await runs.command(id, "submit", observation("submit", args.positionals, "submit", state === "confirmed" ? "succeeded" : "unknown", since));
    return emit(id, "verification.run.submit", observed.row);
  }

  throw validation("verification run", `command is not implemented: ${String(name)}`);
}
