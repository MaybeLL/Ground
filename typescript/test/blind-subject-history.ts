// Frozen payload revision of `patchledger.blind-subject/v1`.
//
// Copied verbatim from `git show 81cb751^:typescript/src/projections.ts`, which is
// the implementation that computed every stored `blind_context_digest` before
// commit 81cb751 (2026-09-07). Commit 81cb751 replaced the payload with the public
// Requirement/Issue versions without changing the `format` string, so stored
// digests from earlier Candidates can only be re-derived with this code.
//
// This file is a historical record used to prove that verification still accepts
// those stored digests. Never update it to match a new implementation; if the
// payload changes again, the contract must gain a new format version instead.
import { sha256 } from "../src/canonical-json.js";
import { CANDIDATE_ARTIFACT_FORMAT, type CandidateFile, type IssueRevision, type RequirementRevision } from "../src/domain.js";
import type { CandidateContextSource } from "../src/projections.js";

interface HistoricalIssueRevision {
  id: string;
  issue_id: string;
  requirement_revision_id: string;
  revision_number: number;
  predecessor_revision_id?: string;
  summary: string;
  context?: string;
  goals: IssueRevision["goals"];
  constraints: IssueRevision["constraints"];
}

const historicalIssueRevisionForContext = (revision: IssueRevision): HistoricalIssueRevision => ({
  id: revision.id,
  issue_id: revision.issue_id,
  requirement_revision_id: revision.requirement_revision_id,
  revision_number: revision.revision_number,
  ...(revision.predecessor_revision_id === undefined ? {} : { predecessor_revision_id: revision.predecessor_revision_id }),
  summary: revision.summary,
  ...(revision.context === undefined ? {} : { context: revision.context }),
  goals: revision.goals,
  constraints: revision.constraints,
});

const comparePathBytes = (left: CandidateFile, right: CandidateFile): number =>
  Buffer.compare(Buffer.from(left.path_bytes, "base64"), Buffer.from(right.path_bytes, "base64"));

const sortedFileManifest = (files: CandidateFile[]): CandidateFile[] => [...files].sort(comparePathBytes);

const hashManifestEntry = (file: CandidateFile) => ({
  path_bytes: file.path_bytes,
  change: file.change,
  ...(file.old_path_bytes === undefined ? {} : { old_path_bytes: file.old_path_bytes }),
  ...(file.old_mode === undefined ? {} : { old_mode: file.old_mode }),
  ...(file.new_mode === undefined ? {} : { new_mode: file.new_mode }),
});

export const historicalBlindSubjectFor = (source: CandidateContextSource) => ({
  format: "patchledger.blind-subject/v1" as const,
  candidate_id: source.candidate_id,
  repository_id: source.repository_id,
  baseline_oid: source.issue_revision.baseline.git_oid,
  result_tree_oid: source.result_tree_oid,
  patch_digest: source.patch_digest,
  artifact_format: CANDIDATE_ARTIFACT_FORMAT,
  requirement_revision: source.requirement_revision as RequirementRevision,
  issue_revision: historicalIssueRevisionForContext(source.issue_revision),
  file_manifest: sortedFileManifest(source.artifact.files).map(hashManifestEntry),
});

export const historicalBlindContextDigestFor = (source: CandidateContextSource): string => sha256(historicalBlindSubjectFor(source));
