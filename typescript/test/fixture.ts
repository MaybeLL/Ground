import { DomainError } from "../src/errors.js";
import { GIT_CANDIDATE_ARTIFACT_FORMAT, type GitCommitArtifact } from "../src/git-artifact-storage.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../src/canonical-json.js";
import type {
  Attribution,
  CandidateArtifact,
  CandidateFile,
  CandidateSubmissionInput,
  EvidenceInput,
  VerificationReportInput,
  SelfVerification,
} from "../src/domain.js";
import {
  Module,
  type CandidateSubmitResult,
  type DevRunContextResult,
  type IssueWriteResult,
  type RepositoryWriteResult,
  type RequirementWriteResult,
  type VerificationSubmitResult,
} from "../src/module.js";
import { enforcePublishGate, enforceStartGate, type PreflightCoordinator } from "../src/preflight.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { indexCandidateChanges } from "../src/change-index.js";

export const testAgent: Attribution = {
  kind: "agent",
  agent_id: "test-agent",
  display_name: "Test Agent",
};

// Blind verification must be performed by an Agent distinct from the
// Candidate developer; the fixture's verifier uses a separate identity.
export const testVerifier: Attribution = {
  kind: "agent",
  agent_id: "test-verifier",
  display_name: "Test Verifier",
};

/**
 * A coordinator for fixtures with a ledger but no Git working tree (pure SQL,
 * or a Session whose network boundary is the ledger facts already recorded).
 * It is NOT a production bypass: it runs the same `enforcePublishGate` /
 * `enforceStartGate` inside the caller's transaction, so every in-transaction
 * binding check still happens. It only replaces the out-of-band `git fetch`
 * that `PreflightService.coordinator` would perform, which these fixtures have
 * no remote for. Real refresh behaviour is covered by fixtures that use the
 * production coordinator against a real bare remote.
 */
export function ledgerOnlyPreflightCoordinator(store: SQLStore): PreflightCoordinator {
  return {
    publish: (input) => store.read(tx => enforcePublishGate(tx, input)),
    start: (input) => store.read(tx => enforceStartGate(tx, input)),
  };
}

export const testBaseline = {
  git_oid: "sha1:0123456789abcdef0123456789abcdef01234567",
  reachability: "unconfirmed" as const,
  warning: "test baseline",
  override_reason: "test",
};

export interface CandidateFixture {
  run: DevRunContextResult;
  candidate: CandidateSubmitResult;
  artifact: CandidateArtifact;
  goal_id: string;
  criterion_id: string;
  submission: CandidateSubmissionInput;
}

export class LedgerFixture {
  private readonly gitArtifacts = new Map<string, CandidateArtifact>();
  private constructor(
    readonly store: SQLStore,
    readonly module: Module,
    readonly requirement: RequirementWriteResult,
    readonly repository: RepositoryWriteResult,
    readonly issue: IssueWriteResult,
    private readonly cleanup: () => Promise<void>,
  ) {
    this.installGitArtifactResolver(store);
  }

  installGitArtifactResolver(store: SQLStore): void {
    store.setGitArtifactResolver(ref => { const artifact = this.gitArtifacts.get(ref.candidate_id); if (!artifact) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Test Git projection not registered"); return artifact; });
  }

  static async create(): Promise<LedgerFixture> {
    const directory = mkdtempSync(join(tmpdir(), "grounds-test-"));
    const store = SQLStore.sqlite(join(directory, "ledger.db"));
    return LedgerFixture.createWithStore(store, async () => {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    });
  }

  static async createWithStore(store: SQLStore, cleanup: () => Promise<void> = () => store.close(), options: { preflightCoordinator?: PreflightCoordinator } = {}): Promise<LedgerFixture> {
    await store.initialize("warn");
    const module = new Module(store, newUUIDv7, undefined, undefined, options.preflightCoordinator ?? ledgerOnlyPreflightCoordinator(store));
    const requirement = await module.createRequirement({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      input: { format: 1, summary: "A test requirement", outcomes: ["The change is observable"] },
    });
    const repository = await module.registerRepository({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      canonical_remote: "ssh://git@example.test/team/repo",
    });
    const issue = await module.createIssue({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      requirement_id: requirement.result.requirement_id,
      requirement_revision_id: requirement.result.requirement_revision_id,
      requirement_revision_explicit: true,
      repository_id: repository.result.repository_id,
      baseline: testBaseline,
      input: {
        format: 1,
        summary: "Implement the change",
        goals: [{ statement: "Change behavior", criteria: ["The behavior changes"], traces_to: [{ type: "outcome", ordinal: 1 }] }],
      },
    });
    return new LedgerFixture(store, module, requirement.result, repository.result, issue.result, cleanup);
  }

  gitCandidateFields(artifact: CandidateArtifact, base = testBaseline.git_oid, fixedSource?: {commit:string; parents:string[]}) {
    const candidateId = newUUIDv7();
    const source = fixedSource ?? { commit: `sha1:${sha256Bytes(Buffer.from(candidateId)).slice(-40)}`, parents: [base] };
    const binding = { repository_id: this.repository.repository_id, canonical_remote: this.repository.canonical_remote, archive_ref: `refs/tags/grounds/candidates/${candidateId}`, source_commit: source.commit, ordered_parents: source.parents, result_tree: artifact.result_tree_oid, base_commit: base };
    const gitArtifact: GitCommitArtifact = { format: GIT_CANDIDATE_ARTIFACT_FORMAT, generator_version: "grounds.canonical-git-diff/v1", binding, receipt: { format: "grounds.git-archive-observation/v1", status: "confirmed", observed_at: "2026-10-16T00:00:00.000Z", binding, remote_source_commit: source.commit, integrity: "complete", protection: { format: "grounds.archive-protection/v1", repository_id: this.repository.repository_id, canonical_remote: this.repository.canonical_remote, ref_namespace: "refs/tags/grounds/candidates/", source: { kind: "verified-deployment-config", locator: "test-fixture", revision: "v1", verified_by: "test" }, observed_at: "2026-10-15T00:00:00.000Z", valid_until: "2026-10-17T00:00:00.000Z", currently_applicable: true, archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true, repository_backup: "verified", database_backup: "verified" } } };
    this.gitArtifacts.set(candidateId, artifact);
    return { candidate_id: candidateId, source, git_artifact: gitArtifact };
  }

  async submitCandidate(
    suffix = "one",
    files?: CandidateFile[],
    evidence: EvidenceInput[] = [],
    explainChanges = false,
    patchOverride?: Buffer,
    issue: IssueWriteResult = this.issue,
    selfVerification?: SelfVerification,
  ): Promise<CandidateFixture> {
    const run = await this.module.startDevRun({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      issue_id: issue.issue_id,
      issue_revision_id: issue.issue_revision_id,
      issue_revision_explicit: false,
      repository_remote_snapshot: this.repository.canonical_remote,
    });
    const goal = run.result.context.issue.goals[0];
    const criterion = goal.criteria[0];
    const artifactFiles = files ?? [{
      path_bytes: Buffer.from(`file-${suffix}`).toString("base64"),
      display_path: `file-${suffix}`,
      change: "modified",
      old_mode: "100644",
      new_mode: "100644",
    }];
    const patch = patchOverride ?? Buffer.concat(artifactFiles.map((file) => {
      const current = Buffer.from(file.path_bytes, "base64");
      const old = file.old_path_bytes ? Buffer.from(file.old_path_bytes, "base64") : current;
      return Buffer.concat([Buffer.from("diff --git a/"), old, Buffer.from(" b/"), current, Buffer.from("\n")]);
    }));
    const artifact: CandidateArtifact = {
      patch,
      patch_digest: sha256Bytes(patch),
      result_tree_oid: suffix === "one"
        ? "sha1:abcdefabcdefabcdefabcdefabcdefabcdefabcd"
        : "sha1:bcdefabcdefabcdefabcdefabcdefabcdefabcde",
      uncompressed_size: patch.length,
      files: artifactFiles,
    };
    const claims = [{
      target_type: "goal" as const,
      target_id: goal.id,
      explanation: "Done",
      criteria: [{ criterion_id: criterion.id, explanation: "Verified", evidence, ...(selfVerification ? { self_verification: selfVerification } : {}) }],
    }];
    const changeIndex = indexCandidateChanges(artifact);
    const submission: CandidateSubmissionInput = explainChanges ? {
      format: "patchledger.candidate-submission/v2",
      explanation: `Implemented ${suffix}`,
      claims,
      change_index: { format: changeIndex.format, patch_digest: changeIndex.patch_digest, units_digest: changeIndex.units_digest },
      change_rationales: changeIndex.change_units.map((unit) => ({
        change_refs: [unit.change_unit_id],
        relation: "implements",
        target_refs: [{ type: "criterion", id: criterion.id }],
        rationale: `This change implements ${criterion.statement}`,
        alternatives: [{ approach: "Leave behavior unchanged", rejected_because: "It would not satisfy the criterion" }],
        risks: ["The changed behavior may affect callers"],
      })),
    } : {
      format: "patchledger.candidate-submission/v1",
      explanation: `Implemented ${suffix}`,
      claims,
    };
    const candidate = await this.module.submitCandidate({
      ...this.gitCandidateFields(artifact, run.result.context.base_commit ?? run.result.context.baseline.git_oid),
      operation_id: newUUIDv7(),
      attribution: testAgent,
      dev_run_id: run.result.context.dev_run.id,
      expected_version: 1,
      artifact,
      submission,
    });
    return { run: run.result, candidate, artifact, goal_id: goal.id, criterion_id: criterion.id, submission };
  }

  async verify(candidate: CandidateFixture, verdict: "qualified" | "rejected" | "inconclusive" = "qualified"): Promise<VerificationSubmitResult> {
    const context = await this.module.verificationContext(candidate.candidate.candidate_id, "blind");
    const report: VerificationReportInput = {
      format: "patchledger.verification-report/v1",
      candidate_id: candidate.candidate.candidate_id,
      result_tree_oid: candidate.artifact.result_tree_oid,
      blind_context_digest: context.context.blind_context_digest,
      assessments: [{
        target_type: "goal",
        target_id: candidate.goal_id,
        criteria: [{
          criterion_id: candidate.criterion_id,
          independent: { verdict, explanation: "Independent result", evidence: [] },
          reconciliation: { claim_relation: "corroborated", explanation: "Compared with the claim" },
          final: { verdict, explanation: "Final result" },
        }],
      }],
    };
    return this.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report });
  }

  async close(): Promise<void> {
    await this.cleanup();
  }
}
