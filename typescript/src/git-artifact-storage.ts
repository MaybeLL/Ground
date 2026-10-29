import { sha256 } from "./canonical-json.js";
import { DomainError } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { validateArchiveProtectionEvidence, validateGitArchiveBinding, type GitArchiveBinding, type GitArchiveObservation } from "./candidate-git-archive.js";
import type { Candidate, CandidateArtifact } from "./domain.js";
import type { CandidateArtifactRef } from "./store-types.js";

export const GIT_CANDIDATE_ARTIFACT_FORMAT = "grounds.git-commit-artifact/v1";
export interface GitCommitArtifact {
  format: typeof GIT_CANDIDATE_ARTIFACT_FORMAT;
  generator_version: "grounds.canonical-git-diff/v1";
  binding: GitArchiveBinding;
  receipt: GitArchiveObservation;
}
/** Local object reads only. Explicit archive fetch belongs to the command layer. */
export type GitArtifactResolver = (ref: CandidateArtifactRef) => CandidateArtifact | Promise<CandidateArtifact>;

export function validateGitCommitArtifact(value: GitCommitArtifact): void {
  const fail = (): never => { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate Git artifact metadata is invalid"); };
  try {
    if (!value || Object.keys(value).sort().join(",") !== "binding,format,generator_version,receipt" || value.format !== GIT_CANDIDATE_ARTIFACT_FORMAT || value.generator_version !== "grounds.canonical-git-diff/v1") fail();
    validateGitArchiveBinding(value.binding);
    if (!isUUIDv7(value.binding.repository_id)) fail();
    const receipt = value.receipt;
    if (!receipt || receipt.format !== "grounds.git-archive-observation/v1" || receipt.status !== "confirmed" || receipt.integrity !== "complete" || receipt.remote_source_commit !== value.binding.source_commit || !Number.isFinite(Date.parse(receipt.observed_at)) || sha256(receipt.binding) !== sha256(value.binding) || !receipt.protection) fail();
    // Historical evidence is checked at the time it attested, not at read time.
    // Current protection/availability must always be observed separately.
    validateArchiveProtectionEvidence(receipt.protection!, value.binding, receipt.observed_at);
  } catch { fail(); }
}

export function validateGitArtifactCandidateBinding(value: GitCommitArtifact, candidate: Pick<Candidate, "id" | "source" | "base_commit" | "repository_remote_snapshot" | "result_tree_oid">): void {
  validateGitCommitArtifact(value);
  const binding = value.binding;
  if (binding.archive_ref !== `refs/tags/grounds/candidates/${candidate.id}` || binding.result_tree !== candidate.result_tree_oid || binding.canonical_remote !== candidate.repository_remote_snapshot || (candidate.base_commit !== undefined && binding.base_commit !== candidate.base_commit) || !candidate.source || binding.source_commit !== candidate.source.commit || sha256(binding.ordered_parents) !== sha256(candidate.source.parents)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate Git artifact does not match its immutable source, base, tree or archive identity");
}

export function assertSupportedCandidateArtifact(format: string, candidateId?: string): void {
  if (format !== GIT_CANDIDATE_ARTIFACT_FORMAT) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "This Candidate artifact format is unsupported; historical patch-only Candidates cannot be read, restored, refined, verified, selected, delivered or converted", false, { ...(candidateId ? { resource_id: candidateId } : {}), artifact_format: format });
}
