import { captureCommittedArtifact, discoverRepository, matchingRemoteNames } from "./git.js";
import { inspectLocalGitArchive, type GitArchiveBinding } from "./candidate-git-archive.js";
import { DomainError } from "./errors.js";
import type { CandidateArtifact } from "./domain.js";

/** Purely local resolver. Fetching is an explicit operation owned by the CLI/service. */
export function deriveLocalGitArtifact(repositoryPath: string, binding: GitArchiveBinding): CandidateArtifact {
  const local = discoverRepository(repositoryPath);
  if (!matchingRemoteNames(local, [binding.canonical_remote]).length) throw new DomainError("WORKTREE_MISMATCH", "Current clone does not match the archived Repository");
  const observation = inspectLocalGitArchive(local.root, binding);
  if (observation.status !== "confirmed") throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Archived source objects are unavailable or inconsistent locally; explicitly fetch this Candidate first", false, { reason: observation.reason ?? observation.status });
  const artifact = captureCommittedArtifact(local.root, binding.base_commit, binding.source_commit);
  if (artifact.result_tree_oid !== binding.result_tree) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Archived source tree differs from its immutable binding");
  return artifact;
}
