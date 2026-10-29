import { isGitOID, isSha256, isUUIDv7, newUUIDv7 } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { validation, DomainError } from "./errors.js";
import { runtimeChange, runtimeGet, type RuntimeRecord } from "./runtime-record.js";
import { validateAttribution, type Attribution } from "./domain.js";
import type { Store } from "./store-types.js";

/**
 * A Verification run is the coordinator's durable record of one round of
 * independent verification: which Candidate, result tree, review session and
 * role it binds, which stages were entered and closed, and how long each
 * lasted. It is stored as a `runtime_operation` row (parent = Candidate) so it
 * needs no SQL schema change and inherits version checking, digests and
 * transactional retry from the runtime store.
 *
 * The record is not a second acceptance verdict: it never carries a
 * qualified/rejected/inconclusive judgement. Stage timing is wall clock; only
 * commands run through a supported entry (the CLI itself) are recorded, and
 * everything else is reported as uncollected rather than inferred.
 */

export const VERIFICATION_RUN_FORMAT = "grounds.verification-run/v1" as const;
export type VerificationRunRole = "contract" | "quality";

/** Pipeline stages plus the observable external-wait stage. */
export const RUN_STAGES = ["prepare", "blind", "freeze", "reconcile", "handoff", "submit", "wait"] as const;
export type RunStage = (typeof RUN_STAGES)[number];
export const RUN_STAGE_STATES = ["running", "succeeded", "failed", "blocked", "skipped", "unknown"] as const;
export type StageState = (typeof RUN_STAGE_STATES)[number];

/** Stages the coordinator enters (`running`) and closes herself, because the work they span is not CLI-observable. */
export const COORDINATOR_STAGES: RunStage[] = ["blind", "reconcile", "wait"];
/** Stages a CLI entry opens and closes itself: the coordinator may only force failed/unknown, never success. */
export const ENTRY_SPANNED_STAGES: RunStage[] = ["prepare", "freeze", "handoff", "submit"];

export interface StageAttempt {
  attempt: number;
  started_at: string;
  state: StageState;
  ended_at?: string;
  duration_ms?: number;
  reason?: string;
}

/** A CLI-observed command. Only a non-sensitive entry label and an argv digest are kept, never raw arguments. */
export interface RunCommand {
  stage: RunStage;
  entry: string;
  argv_digest: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  state: "succeeded" | "failed" | "unknown";
  exit_code?: number;
}

export interface RunEnvironment {
  identity: string;
  asset?: string;
  lease?: string;
  hit: boolean;
  reason: string;
  state: StageState;
  recorded_at: string;
}

export interface RunFreeze {
  independent_digest: string;
  fixed_at: string;
  copy_path?: string;
}

export interface RunHandoff {
  state: "signed" | "unknown";
  report_digest: string;
  path?: string;
  recorded_at: string;
}

export interface RunSubmit {
  state: "pending" | "confirmed" | "unknown";
  operation_id: string;
  verification_id?: string;
  recorded_at: string;
}

export interface VerificationRunData {
  format: typeof VERIFICATION_RUN_FORMAT;
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  role: VerificationRunRole;
  review_session_id: string;
  review_worktree: string;
  created_at: string;
  updated_at: string;
  attribution: Attribution;
  stages: Partial<Record<RunStage, StageAttempt[]>>;
  commands: RunCommand[];
  anomalies: string[];
  environment?: RunEnvironment;
  freeze?: RunFreeze;
  handoff?: RunHandoff;
  submit?: RunSubmit;
}

const MAX_COMMANDS = 500;
const MAX_ATTEMPTS = 64;

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const time = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export const isRunRecord = (row: RuntimeRecord): boolean => row.kind === "runtime_operation" && row.data.format === VERIFICATION_RUN_FORMAT;

/** Validate persisted run data; a corrupt or foreign-shape record must fail loudly, not be reinterpreted. */
export function runData(row: RuntimeRecord): VerificationRunData {
  const value = row.data as unknown as VerificationRunData;
  if (!isRunRecord(row) || !isUUIDv7(value.candidate_id) || value.candidate_id !== row.parent_id)
    throw validation("verification_run", "invalid Candidate binding");
  if (!isGitOID(value.result_tree_oid) || !isSha256(value.blind_context_digest)) throw validation("verification_run", "invalid result tree or blind digest");
  if (value.role !== "contract" && value.role !== "quality") throw validation("verification_run", "role must be contract or quality");
  if (!isUUIDv7(value.review_session_id)) throw validation("verification_run", "invalid review session");
  if (!text(value.review_worktree, 4096) || !time(value.created_at) || !time(value.updated_at)) throw validation("verification_run", "invalid session or timestamps");
  validateAttribution(value.attribution);
  if (!value.stages || typeof value.stages !== "object" || Array.isArray(value.stages)) throw validation("verification_run", "stages must be an object");
  for (const [stage, attempts] of Object.entries(value.stages)) {
    if (!RUN_STAGES.includes(stage as RunStage) || !Array.isArray(attempts) || attempts.length > MAX_ATTEMPTS) throw validation("verification_run", "invalid stage attempts");
    for (const attempt of attempts) {
      if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1 || !time(attempt.started_at) || !RUN_STAGE_STATES.includes(attempt.state)) throw validation("verification_run", "invalid stage attempt");
      if (attempt.ended_at !== undefined && !time(attempt.ended_at)) throw validation("verification_run", "invalid stage end");
      const closed = attempt.state !== "running";
      if (closed !== (attempt.ended_at !== undefined && attempt.duration_ms !== undefined)) throw validation("verification_run", "closed stages require an end and duration");
      if (attempt.duration_ms !== undefined && (!Number.isSafeInteger(attempt.duration_ms) || attempt.duration_ms < 0)) throw validation("verification_run", "durations must not be negative");
    }
  }
  if (!Array.isArray(value.commands) || value.commands.length > MAX_COMMANDS) throw validation("verification_run", "invalid command log");
  for (const command of value.commands) {
    if (!RUN_STAGES.includes(command.stage) || !text(command.entry, 128) || !isSha256(command.argv_digest) || !time(command.started_at) || !time(command.ended_at))
      throw validation("verification_run", "invalid command record");
    if (!Number.isSafeInteger(command.duration_ms) || command.duration_ms < 0) throw validation("verification_run", "command durations must not be negative");
    if (!["succeeded", "failed", "unknown"].includes(command.state)) throw validation("verification_run", "invalid command state");
  }
  if (!Array.isArray(value.anomalies)) throw validation("verification_run", "anomalies must be an array");
  if (value.handoff && (value.handoff.state !== "signed" && value.handoff.state !== "unknown" || !isSha256(value.handoff.report_digest) || !time(value.handoff.recorded_at))) throw validation("verification_run", "invalid handoff state");
  if (value.submit && (!["pending", "confirmed", "unknown"].includes(value.submit.state) || !isUUIDv7(value.submit.operation_id) || !time(value.submit.recorded_at))) throw validation("verification_run", "invalid submit state");
  if (value.freeze && (!isSha256(value.freeze.independent_digest) || !time(value.freeze.fixed_at))) throw validation("verification_run", "invalid freeze record");
  return value;
}

/** Stage timing is wall clock; a negative interval means a clock anomaly, not a real duration. */
const durationBetween = (startedAt: string, endedAt: string, anomalies: string[], label: string): number => {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0) {
    anomalies.push(`${label}: non-monotonic clock between ${startedAt} and ${endedAt}`);
    return 0;
  }
  return duration;
};

const latest = (attempts: StageAttempt[] | undefined): StageAttempt | undefined => attempts && attempts.length ? attempts[attempts.length - 1] : undefined;

export const runningStage = (data: VerificationRunData, stage: RunStage): StageAttempt | undefined => {
  const attempt = latest(data.stages[stage]);
  return attempt && attempt.state === "running" ? attempt : undefined;
};

export interface BeginRunInput {
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  role: VerificationRunRole;
  review_session_id: string;
  review_worktree: string;
  attribution: Attribution;
  at?: string;
}

/** Open a run with `prepare` already running; the CLI closes it when material preparation finishes. */
export function beginRunData(input: BeginRunInput): VerificationRunData {
  const at = input.at ?? new Date().toISOString();
  const data: VerificationRunData = {
    format: VERIFICATION_RUN_FORMAT,
    candidate_id: input.candidate_id,
    result_tree_oid: input.result_tree_oid,
    blind_context_digest: input.blind_context_digest,
    role: input.role,
    review_session_id: input.review_session_id,
    review_worktree: input.review_worktree,
    created_at: at,
    updated_at: at,
    attribution: input.attribution,
    stages: { prepare: [{ attempt: 1, started_at: at, state: "running" }] },
    commands: [],
    anomalies: [],
  };
  return data;
}

export function enterStage(data: VerificationRunData, stage: RunStage, at: string): void {
  const attempts = data.stages[stage] ?? [];
  const open = latest(attempts);
  if (open && open.state === "running") throw new DomainError("STATE_CONFLICT", `stage ${stage} is already running`, false, { reason: "stage_already_running", stage });
  if (attempts.length >= MAX_ATTEMPTS) throw validation("verification_run", `stage ${stage} exceeds ${MAX_ATTEMPTS} attempts`);
  attempts.push({ attempt: attempts.length + 1, started_at: at, state: "running" });
  data.stages[stage] = attempts;
  data.updated_at = at;
}

export function closeStage(data: VerificationRunData, stage: RunStage, state: Exclude<StageState, "running">, at: string, reason?: string): void {
  const open = runningStage(data, stage);
  if (!open) throw new DomainError("STATE_CONFLICT", `stage ${stage} was not entered; refusing to mark it ${state}`, false, { reason: "stage_not_entered", stage });
  open.ended_at = at;
  open.state = state;
  open.duration_ms = durationBetween(open.started_at, at, data.anomalies, `stage ${stage}`);
  if (reason !== undefined) open.reason = reason;
  data.updated_at = at;
}

export function recordCommand(data: VerificationRunData, command: Omit<RunCommand, "duration_ms">): void {
  if (data.commands.length >= MAX_COMMANDS) throw validation("verification_run", `command log exceeds ${MAX_COMMANDS} entries`);
  data.commands.push({ ...command, duration_ms: durationBetween(command.started_at, command.ended_at, data.anomalies, `command ${command.entry}`) });
  data.updated_at = command.ended_at;
}

/** A digest of the argv so the log identifies a command without retaining any raw argument (paths, tokens). */
export const commandDigest = (argv: readonly string[]): string => sha256([...argv]);

export interface StageSummary {
  stage: RunStage;
  state: StageState;
  attempts: number;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  reason?: string;
  complete: boolean;
}

export interface RunSummary {
  format: typeof VERIFICATION_RUN_FORMAT;
  run_id: string;
  version: number;
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  role: VerificationRunRole;
  review_session_id: string;
  created_at: string;
  updated_at: string;
  current_stage?: RunStage;
  stages: StageSummary[];
  elapsed_ms: number;
  commands: { collected: number; duration_ms: number; uncollected_interval_ms: number };
  freeze?: RunFreeze;
  handoff?: RunHandoff;
  submit?: RunSubmit;
  environment?: RunEnvironment;
  anomalies: string[];
  timing_basis: {
    unit: "ms";
    stage_duration: "wall clock between stage entry and exit";
    total: "union of closed stage intervals, so parallel stages are counted once";
    commands: "only commands run through a supported entry are collected; other time is uncollected";
    missing: "stages still running or never entered carry no duration and are not counted as complete";
    clock: "negative or unparsable intervals are reported as anomalies and contribute zero";
  };
}

/** Merge closed intervals so overlapping (parallel) stages are counted once in the total. */
export function unionDuration(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([start, end]) => end > start).sort((left, right) => left[0] - right[0]);
  let total = 0;
  let cursorStart: number | undefined;
  let cursorEnd = 0;
  for (const [start, end] of sorted) {
    if (cursorStart === undefined) { cursorStart = start; cursorEnd = end; continue; }
    if (start > cursorEnd) { total += cursorEnd - cursorStart; cursorStart = start; cursorEnd = end; }
    else cursorEnd = Math.max(cursorEnd, end);
  }
  if (cursorStart !== undefined) total += cursorEnd - cursorStart;
  return total;
}

export function summarize(runId: string, row: RuntimeRecord): RunSummary {
  const data = runData(row);
  const intervals: Array<[number, number]> = [];
  const stages: StageSummary[] = [];
  for (const stage of RUN_STAGES) {
    const attempts = data.stages[stage];
    if (!attempts || !attempts.length) continue;
    const attempt = attempts[attempts.length - 1]!;
    const complete = attempt.state !== "running";
    if (complete && attempt.ended_at) intervals.push([Date.parse(attempt.started_at), Date.parse(attempt.ended_at)]);
    stages.push({ stage, state: attempt.state, attempts: attempts.length, started_at: attempt.started_at, ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}), ...(attempt.duration_ms !== undefined ? { duration_ms: attempt.duration_ms } : {}), ...(attempt.reason ? { reason: attempt.reason } : {}), complete });
  }
  const openStage = RUN_STAGES.map((stage) => [stage, runningStage(data, stage)] as const).filter(([, attempt]) => attempt !== undefined);
  const commandDuration = data.commands.reduce((total, command) => total + command.duration_ms, 0);
  const elapsed = unionDuration(intervals);
  const closedStageIntervals: Array<[number, number]> = [];
  for (const stage of RUN_STAGES) for (const attempt of data.stages[stage] ?? []) if (attempt.ended_at) closedStageIntervals.push([Date.parse(attempt.started_at), Date.parse(attempt.ended_at)]);
  const union = unionDuration(closedStageIntervals);
  return {
    format: VERIFICATION_RUN_FORMAT,
    run_id: runId,
    version: row.version,
    candidate_id: data.candidate_id,
    result_tree_oid: data.result_tree_oid,
    blind_context_digest: data.blind_context_digest,
    role: data.role,
    review_session_id: data.review_session_id,
    created_at: data.created_at,
    updated_at: data.updated_at,
    ...(openStage.length ? { current_stage: openStage[openStage.length - 1]![0] } : {}),
    stages,
    elapsed_ms: elapsed,
    commands: { collected: data.commands.length, duration_ms: commandDuration, uncollected_interval_ms: Math.max(0, union - commandDuration) },
    ...(data.freeze ? { freeze: data.freeze } : {}),
    ...(data.handoff ? { handoff: data.handoff } : {}),
    ...(data.submit ? { submit: data.submit } : {}),
    ...(data.environment ? { environment: data.environment } : {}),
    anomalies: data.anomalies,
    timing_basis: {
      unit: "ms",
      stage_duration: "wall clock between stage entry and exit",
      total: "union of closed stage intervals, so parallel stages are counted once",
      commands: "only commands run through a supported entry are collected; other time is uncollected",
      missing: "stages still running or never entered carry no duration and are not counted as complete",
      clock: "negative or unparsable intervals are reported as anomalies and contribute zero",
    },
  };
}

/** Store-backed operations on Verification run records. Every write is a versioned runtime-record update. */
export class VerificationRuns {
  constructor(private readonly store: Store, private readonly newId: () => string = newUUIDv7) {}

  private async mutate<T>(id: string, change: (data: VerificationRunData, at: string) => T, at = new Date().toISOString()): Promise<{ row: RuntimeRecord; value: T }> {
    if (!isUUIDv7(id)) throw validation("run_id", "must be a lowercase UUIDv7");
    let value: T;
    const row = await runtimeChange(this.store, "runtime_operation", id, (candidate) => {
      const data = runData(candidate);
      value = change(data, at);
      candidate.data = data as unknown as Record<string, unknown>;
    });
    return { row, value: value! };
  }

  async begin(input: BeginRunInput): Promise<RuntimeRecord> {
    const at = input.at ?? new Date().toISOString();
    if (!isUUIDv7(input.candidate_id)) throw validation("candidate", "must be a lowercase UUIDv7");
    const row: RuntimeRecord = { id: this.newId(), kind: "runtime_operation", parent_id: input.candidate_id, version: 1, data: beginRunData({ ...input, at }) as unknown as Record<string, unknown> };
    return this.store.write(async (tx) => { await tx.saveRuntimeRecord(row, 0); return row; });
  }

  async show(id: string): Promise<RuntimeRecord> {
    if (!isUUIDv7(id)) throw validation("run_id", "must be a lowercase UUIDv7");
    return this.store.read(async (tx) => {
      const row = await runtimeGet(tx, "runtime_operation", id);
      runData(row);
      return row;
    });
  }

  /** Runs bound to one Candidate; the newest by created_at wins when several rounds exist. */
  async listForCandidate(candidateId: string): Promise<RuntimeRecord[]> {
    if (!isUUIDv7(candidateId)) throw validation("candidate", "must be a lowercase UUIDv7");
    return this.store.read(async (tx) => (await tx.listRuntimeRecords("runtime_operation", candidateId)).filter(isRunRecord));
  }

  async latest(candidateId: string, role: VerificationRunRole, sessionId?: string): Promise<RuntimeRecord | undefined> {
    const rows = await this.listForCandidate(candidateId);
    const matching = rows.filter((row) => { const data = runData(row); return data.role === role && (sessionId === undefined || data.review_session_id === sessionId); });
    return matching.sort((left, right) => runData(left).created_at < runData(right).created_at ? 1 : -1)[0];
  }

  async stage(id: string, stage: RunStage, state: StageState, reason?: string): Promise<{ row: RuntimeRecord; value: undefined }> {
    return this.mutate(id, (data, at) => {
      if (state === "running") enterStage(data, stage, at);
      else closeStage(data, stage, state, at, reason);
      return undefined;
    });
  }

  /** Enter a coordinator stage if it is not already running; a repeated entry is a no-op, not a conflict. */
  async ensureStage(id: string, stage: RunStage): Promise<{ row: RuntimeRecord; value: undefined }> {
    return this.mutate(id, (data, at) => {
      if (!runningStage(data, stage)) enterStage(data, stage, at);
      return undefined;
    });
  }

  /**
   * Run one CLI-owned phase as a measured span: enter the stage (running), perform `action`, then
   * close it succeeded on return or failed on throw. A stage whose entry crashes stays `running` and
   * is closed by the coordinator, so an interrupted phase is never silently reported as complete.
   */
  async span<T>(id: string, stage: RunStage, action: () => Promise<T>): Promise<T> {
    await this.stage(id, stage, "running");
    try {
      const value = await action();
      await this.stage(id, stage, "succeeded");
      return value;
    } catch (error) {
      await this.stage(id, stage, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  command(id: string, stage: RunStage, input: { entry: string; argv_digest: string; started_at: string; ended_at: string; state: RunCommand["state"]; exit_code?: number }): Promise<{ row: RuntimeRecord; value: undefined }> {
    return this.mutate(id, (data) => { recordCommand(data, { stage, ...input }); return undefined; });
  }

  bindEnvironment(id: string, environment: RunEnvironment): Promise<{ row: RuntimeRecord; value: undefined }> {
    return this.mutate(id, (data) => { data.environment = environment; return undefined; });
  }

  freeze(id: string, independentDigest: string, copyPath?: string): Promise<{ row: RuntimeRecord; value: undefined }> {
    if (!isSha256(independentDigest)) throw validation("independent_digest", "must be a lowercase sha256 digest");
    return this.mutate(id, (data, at) => {
      if (data.freeze && data.freeze.independent_digest !== independentDigest) throw new DomainError("STATE_CONFLICT", "the frozen blind assessment cannot be replaced with a different digest", false, { reason: "freeze_immutable" });
      if (data.freeze) return undefined;
      if (latest(data.stages.blind)?.state !== "succeeded") throw new DomainError("STATE_CONFLICT", "record the blind stage as succeeded before freezing its assessment", false, { reason: "blind_not_closed" });
      data.freeze = { independent_digest: independentDigest, fixed_at: at, ...(copyPath ? { copy_path: copyPath } : {}) };
      return undefined;
    });
  }

  recordHandoff(id: string, reportDigest: string, state: RunHandoff["state"], path?: string): Promise<{ row: RuntimeRecord; value: undefined }> {
    if (!isSha256(reportDigest)) throw validation("report_digest", "must be a lowercase sha256 digest");
    return this.mutate(id, (data, at) => { data.handoff = { state, report_digest: reportDigest, recorded_at: at, ...(path ? { path } : {}) }; return undefined; });
  }

  recordSubmit(id: string, state: RunSubmit["state"], operationId: string, verificationId?: string): Promise<{ row: RuntimeRecord; value: undefined }> {
    if (!isUUIDv7(operationId)) throw validation("operation_id", "must be a lowercase UUIDv7");
    if (state === "confirmed" && !verificationId) throw validation("verification_id", "a confirmed submit requires its Verification ID");
    return this.mutate(id, (data, at) => {
      // A confirmed submit is terminal and cannot be replaced by a later unknown retry.
      if (data.submit?.state === "confirmed") return undefined;
      data.submit = { state, operation_id: operationId, recorded_at: at, ...(verificationId ? { verification_id: verificationId } : {}) };
      return undefined;
    });
  }
}

/**
 * Automatic observation of the coordinator's own verification entries.
 *
 * A run is only auto-observed when the caller passes the exact `--review-session` the run was
 * created with; a legacy caller that never created a run, or one that passes a different session,
 * is left completely untouched. This keeps existing flows working (the observation is additive) and
 * refuses to silently attach a step to the wrong run.
 */
export class VerificationRunObserver {
  private readonly runs: VerificationRuns;
  constructor(private readonly store: Store, newId: () => string = newUUIDv7) { this.runs = new VerificationRuns(store, newId); }

  /** The active run for (candidate, session); the role is read from the run rather than guessed by the caller. */
  async find(candidateId: string, sessionId: string): Promise<RuntimeRecord | undefined> {
    if (!isUUIDv7(candidateId) || !isUUIDv7(sessionId)) return undefined;
    const rows = await this.runs.listForCandidate(candidateId);
    const matching = rows.filter((row) => runData(row).review_session_id === sessionId).sort((left, right) => runData(left).created_at < runData(right).created_at ? 1 : -1);
    return matching[0];
  }

  /**
   * The single run a submitted report can be attributed to. A report is bound to a Candidate and a
   * blind context digest; when several runs share that binding (for example a retried round) the
   * observation is skipped rather than guessed, so `verification run submit` remains the explicit path.
   */
  async findByReport(candidateId: string, blindContextDigest: string, role: VerificationRunRole): Promise<RuntimeRecord | undefined> {
    if (!isUUIDv7(candidateId) || !isSha256(blindContextDigest)) return undefined;
    const rows = await this.runs.listForCandidate(candidateId);
    const matching = rows.filter((row) => { const data = runData(row); return data.blind_context_digest === blindContextDigest && data.role === role; });
    return matching.length === 1 ? matching[0] : undefined;
  }

  /**
   * Refuse to hand out reconcile material before the blind assessment is frozen. When no run is bound
   * to this session the gate does not apply, so an already-running legacy verification is unaffected.
   */
  async assertReconcileAllowed(candidateId: string, sessionId: string): Promise<void> {
    const row = await this.find(candidateId, sessionId);
    if (!row) return;
    const data = runData(row);
    const blind = data.stages.blind;
    const blindClosed = blind && blind.length && blind[blind.length - 1]!.state === "succeeded";
    if (!blindClosed) throw new DomainError("STATE_CONFLICT", "the blind assessment is not closed yet; finish it and record the blind stage as succeeded before requesting reconcile material", false, { reason: "blind_not_closed", run_id: row.id });
    if (!data.freeze) throw new DomainError("STATE_CONFLICT", "the blind independent part is not frozen; fix its digest before requesting reconcile material", false, { reason: "blind_not_frozen", run_id: row.id });
  }
}
