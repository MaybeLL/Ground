// What the migration needs to know about the previous ledger model, as plain
// data. The reader behind this port is the only code that knows its tables.
export type LegacyVerdict = "qualified" | "rejected" | "inconclusive";
export type LegacyRunStage = "prepare" | "blind" | "freeze" | "reconcile" | "handoff" | "submit" | "wait";

export interface LegacyCriterion { readonly id: string; readonly statement: string }
export interface LegacyGoal { readonly id: string; readonly statement: string; readonly criteria: readonly LegacyCriterion[] }
export interface LegacyConstraint { readonly id: string; readonly statement: string; readonly rationale?: string; readonly criteria: readonly LegacyCriterion[] }
export interface LegacyIssueRevision {
  readonly id: string;
  readonly number: number;
  readonly requirementRevisionId: string;
  readonly summary: string;
  readonly context?: string;
  readonly plan?: string;
  readonly baselineOid: string;
  readonly createdAt: string;
  readonly goals: readonly LegacyGoal[];
  readonly constraints: readonly LegacyConstraint[];
}
export interface LegacyIssue { readonly id: string; readonly repositoryId: string; readonly createdAt: string; readonly revisions: readonly LegacyIssueRevision[] }

export interface LegacyCandidate {
  readonly id: string;
  readonly devRunId: string;
  readonly issueRevisionId: string;
  readonly patchDigest: string;
  readonly resultTreeOid: string;
  readonly artifactFormat: string;
  readonly blindContextDigest: string;
  readonly createdAt: string;
}
export interface LegacyDevRun {
  readonly id: string;
  readonly issueId: string;
  readonly issueRevisionId: string;
  readonly state: "open" | "submitted" | "abandoned";
  readonly refinesCandidateId?: string;
  readonly abandonReason?: string;
  readonly createdAt: string;
  readonly candidate?: LegacyCandidate;
}

export interface LegacyAssessment {
  readonly criterionId: string;
  readonly independent: LegacyVerdict;
  readonly independentExplanation: string;
  readonly reconciliation: "corroborated" | "contradicted" | "not_determined";
  readonly reconciliationExplanation: string;
  readonly final: LegacyVerdict;
  readonly finalExplanation: string;
  readonly evidence: readonly { readonly command: string; readonly exitCode: number; readonly outputDigest: string }[];
}
export interface LegacyStageAttempt { readonly state: string; readonly startedAt: string; readonly endedAt?: string }
export interface LegacyVerificationRun {
  readonly reviewSessionId: string;
  readonly stages: Readonly<Partial<Record<LegacyRunStage, readonly LegacyStageAttempt[]>>>;
  readonly freezeDigest?: string;
  readonly commands: readonly { readonly stage: LegacyRunStage; readonly entry: string; readonly argvDigest: string; readonly state: "succeeded" | "failed" | "unknown"; readonly exitCode?: number; readonly endedAt: string }[];
}
export interface LegacyVerification {
  readonly id: string;
  readonly candidateId: string;
  readonly blindContextDigest: string;
  readonly createdAt: string;
  readonly agent: { readonly kind: "human" | "agent"; readonly id?: string; readonly name?: string };
  readonly assessments: readonly LegacyAssessment[];
  /** The contract-role run that submitted this verification, when the ledger still has it. */
  readonly run?: LegacyVerificationRun;
}

export interface LegacySnapshot {
  readonly issues: readonly LegacyIssue[];
  readonly devRuns: readonly LegacyDevRun[];
  readonly verifications: readonly LegacyVerification[];
  /** Quality reviews are not part of this migration; they stay readable in the old tables. */
  readonly qualityReviewCount: number;
}

export interface LegacyLedgerReader {
  /** One consistent read of everything the migration maps. */
  read(): Promise<LegacySnapshot>;
}
