import { asText, parseDate } from "../../../sql-shared.js";
import type { SQLClient } from "../../../sql-client.js";
import type { SQLStore } from "../../../sql-store.js";
import type {
  LedgerIntegrityProbe, LegacyAssessment, LegacyCandidate, LegacyDevRun, LegacyIssue, LegacyIssueRevision, LegacyLedgerReader, LegacyRunStage, LegacySnapshot, LegacyStageAttempt,
  LegacyVerification, LegacyVerificationRun, LegacyVerdict,
} from "../../ports/index.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => asText(value);
const optional = (value: unknown): string | undefined => value === null || value === undefined ? undefined : asText(value);
const group = <T>(rows: readonly Row[], key: string, map: (row: Row) => T): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const row of rows) { const k = text(row[key]); out.set(k, [...(out.get(k) ?? []), map(row)]); }
  return out;
};

/** Reads the previous model's tables in one transaction. It never writes to them. */
export class SqlLegacyReader implements LegacyLedgerReader {
  constructor(private readonly store: SQLStore) {}

  read(): Promise<LegacySnapshot> {
    return this.store.transaction(false, client => readSnapshot(client));
  }
}

export class SqlLedgerIntegrityProbe implements LedgerIntegrityProbe {
  constructor(private readonly store: SQLStore) {}

  async check(): Promise<{ valid: boolean; findings: string[] }> {
    const { report } = await this.store.inspectIntegrity();
    return { valid: report.valid, findings: report.issues.map(i => `${i.check}${i.resource_id ? ` ${i.resource_type ?? ""} ${i.resource_id}` : ""}: ${i.reason}`) };
  }
}

async function readSnapshot(client: SQLClient): Promise<LegacySnapshot> {
  const all = (sql: string): Promise<Row[]> => client.all<Row>(sql);
  const issues = await all("SELECT id, repository_id, created_at FROM issues ORDER BY id");
  const revisions = await all("SELECT id, issue_id, requirement_revision_id, revision_number, baseline_oid, summary, context, plan, created_at FROM issue_revisions ORDER BY issue_id, revision_number");
  const goals = await all("SELECT id, issue_revision_id, statement FROM goals ORDER BY issue_revision_id, ordinal");
  const constraints = await all("SELECT id, issue_revision_id, statement, rationale FROM constraints ORDER BY issue_revision_id, ordinal");
  const criteria = await all("SELECT id, target_id, statement FROM criteria ORDER BY target_id, ordinal");
  const runs = await all("SELECT d.id, d.issue_revision_id, r.issue_id, d.state, d.refines_candidate_id, d.abandon_reason, d.created_at FROM dev_runs d JOIN issue_revisions r ON r.id = d.issue_revision_id ORDER BY d.id");
  const candidates = await all("SELECT id, dev_run_id, issue_revision_id, patch_digest, result_tree_oid, artifact_format, blind_context_digest, created_at FROM candidates ORDER BY id");
  const verifications = await all("SELECT id, candidate_id, blind_context_digest, created_at, attribution_json FROM verifications ORDER BY id");
  const assessments = await all("SELECT verification_id, criterion_id, independent_verdict, independent_explanation, reconciliation_relation, reconciliation_explanation, final_verdict, final_explanation FROM verification_assessments ORDER BY verification_id, target_type, target_id, criterion_id");
  const evidence = await all("SELECT verification_id, criterion_id, ordinal, command, exit_code, output_digest FROM verification_evidence ORDER BY verification_id, criterion_id, ordinal");
  const records = await all("SELECT record_json FROM runtime_records WHERE kind = 'runtime_operation' AND parent_id IS NOT NULL ORDER BY id");
  const quality = await client.get<Row>("SELECT COUNT(*) AS n FROM verification_quality_reviews");

  const criteriaByTarget = group(criteria, "target_id", r => ({ id: text(r.id), statement: text(r.statement) }));
  const goalsByRevision = group(goals, "issue_revision_id", r => ({ id: text(r.id), statement: text(r.statement), criteria: criteriaByTarget.get(text(r.id)) ?? [] }));
  const constraintsByRevision = group(constraints, "issue_revision_id", r => ({ id: text(r.id), statement: text(r.statement), ...(optional(r.rationale) ? { rationale: optional(r.rationale)! } : {}), criteria: criteriaByTarget.get(text(r.id)) ?? [] }));
  const revisionsByIssue = group(revisions, "issue_id", (r): LegacyIssueRevision => ({
    id: text(r.id), number: Number(r.revision_number), requirementRevisionId: text(r.requirement_revision_id), summary: text(r.summary), ...(optional(r.context) ? { context: optional(r.context)! } : {}),
    ...(optional(r.plan) ? { plan: optional(r.plan)! } : {}), baselineOid: text(r.baseline_oid), createdAt: parseDate(r.created_at), goals: goalsByRevision.get(text(r.id)) ?? [], constraints: constraintsByRevision.get(text(r.id)) ?? [],
  }));
  const issueList: LegacyIssue[] = issues.map(r => ({ id: text(r.id), repositoryId: text(r.repository_id), createdAt: parseDate(r.created_at), revisions: revisionsByIssue.get(text(r.id)) ?? [] }));

  const candidateByRun = new Map<string, LegacyCandidate>(candidates.map(r => [text(r.dev_run_id), {
    id: text(r.id), devRunId: text(r.dev_run_id), issueRevisionId: text(r.issue_revision_id), patchDigest: text(r.patch_digest), resultTreeOid: text(r.result_tree_oid),
    artifactFormat: text(r.artifact_format), blindContextDigest: text(r.blind_context_digest), createdAt: parseDate(r.created_at),
  }]));
  const devRuns: LegacyDevRun[] = runs.map(r => ({
    id: text(r.id), issueId: text(r.issue_id), issueRevisionId: text(r.issue_revision_id), state: text(r.state) as LegacyDevRun["state"],
    ...(optional(r.refines_candidate_id) ? { refinesCandidateId: optional(r.refines_candidate_id)! } : {}), ...(optional(r.abandon_reason) ? { abandonReason: optional(r.abandon_reason)! } : {}),
    createdAt: parseDate(r.created_at), ...(candidateByRun.has(text(r.id)) ? { candidate: candidateByRun.get(text(r.id))! } : {}),
  }));

  const evidenceByCriterion = group(evidence, "verification_id", r => ({ criterionId: text(r.criterion_id), command: text(r.command), exitCode: Number(r.exit_code), outputDigest: text(r.output_digest) }));
  const assessmentsByVerification = group(assessments, "verification_id", r => r);
  const runsByVerification = new Map<string, LegacyVerificationRun>();
  for (const row of records) {
    const record = JSON.parse(text(row.record_json)) as { data?: Record<string, unknown> };
    const data = record.data as { format?: string; role?: string; review_session_id?: string; stages?: Record<string, Array<{ state: string; started_at: string; ended_at?: string }>>; freeze?: { independent_digest?: string; fixed_at?: string }; handoff?: { state?: string; recorded_at?: string };
      commands?: Array<{ stage: LegacyRunStage; entry: string; argv_digest: string; state: "succeeded" | "failed" | "unknown"; exit_code?: number; ended_at: string }>; submit?: { verification_id?: string; state?: string; recorded_at?: string } } | undefined;
    if (!data || data.format !== "grounds.verification-run/v1" || data.role !== "contract" || !data.submit?.verification_id || !data.review_session_id) continue;
    const stages: Partial<Record<LegacyRunStage, LegacyStageAttempt[]>> = {};
    for (const [stage, attempts] of Object.entries(data.stages ?? {})) stages[stage as LegacyRunStage] = attempts.map(a => ({ state: a.state, startedAt: a.started_at, ...(a.ended_at ? { endedAt: a.ended_at } : {}) }));
    runsByVerification.set(data.submit.verification_id, {
      reviewSessionId: data.review_session_id, stages, ...(data.freeze?.independent_digest && data.freeze.fixed_at ? { freeze: { digest: data.freeze.independent_digest, at: data.freeze.fixed_at } } : {}),
      ...(data.handoff?.state === "signed" && data.handoff.recorded_at ? { handoff: { at: data.handoff.recorded_at } } : {}),
      ...(data.submit.state === "confirmed" && data.submit.recorded_at ? { submit: { at: data.submit.recorded_at } } : {}),
      commands: (data.commands ?? []).map(c => ({ stage: c.stage, entry: c.entry, argvDigest: c.argv_digest, state: c.state, ...(c.exit_code !== undefined ? { exitCode: c.exit_code } : {}), endedAt: c.ended_at })),
    });
  }
  const verificationList: LegacyVerification[] = verifications.map(r => {
    const attribution = JSON.parse(text(r.attribution_json)) as { kind: "human" | "agent"; agent_id?: string; display_name?: string; git_name?: string };
    const evidenceRows = evidenceByCriterion.get(text(r.id)) ?? [];
    return {
      id: text(r.id), candidateId: text(r.candidate_id), blindContextDigest: text(r.blind_context_digest), createdAt: parseDate(r.created_at),
      agent: { kind: attribution.kind, ...(attribution.agent_id ? { id: attribution.agent_id } : {}), ...(attribution.display_name ?? attribution.git_name ? { name: (attribution.display_name ?? attribution.git_name)! } : {}) },
      assessments: (assessmentsByVerification.get(text(r.id)) ?? []).map((a): LegacyAssessment => ({
        criterionId: text(a.criterion_id), independent: text(a.independent_verdict) as LegacyVerdict, independentExplanation: text(a.independent_explanation),
        reconciliation: text(a.reconciliation_relation) as LegacyAssessment["reconciliation"], reconciliationExplanation: text(a.reconciliation_explanation),
        final: text(a.final_verdict) as LegacyVerdict, finalExplanation: text(a.final_explanation),
        evidence: evidenceRows.filter(e => e.criterionId === text(a.criterion_id)).map(e => ({ command: e.command, exitCode: e.exitCode, outputDigest: e.outputDigest })),
      })),
      ...(runsByVerification.has(text(r.id)) ? { run: runsByVerification.get(text(r.id))! } : {}),
    };
  });
  return { issues: issueList, devRuns, verifications: verificationList, qualityReviewCount: Number(quality?.n ?? 0) };
}
