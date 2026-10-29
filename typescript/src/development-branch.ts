import { repositoryDataRoot } from "./data-layout.js";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { sha256 } from "./canonical-json.js";
import { captureArtifact, captureCommittedArtifact, resolveBaseline } from "./git.js";
import { historyGit, historyBytes, assertHistoryRepository, rawOID } from "./git-history-read.js";
import { readCommit } from "./integration-history.js";
import { runGitWithEnv } from "./git-command.js";
import { atomicPrivateWrite, safeRead } from "./runtime-files.js";
import { isGitOID, isUUIDv7 } from "./identity.js";
import { ensureGroundsExcluded, assertNoTrackedGroundsRuntime, isPrivateGroundsPath } from "./grounds-exclude.js";
import { validation, worktreeMismatch } from "./errors.js";
import { assertCapturableSubmodules } from "./git-submodules.js";
import type { TargetBranch, CandidateArtifact } from "./domain.js";

export interface DevelopmentIdentity { format: "grounds.development-branch/v1"; workspace_id: string; branch: string }
export interface DevelopmentPlan extends DevelopmentIdentity {
  database_id: string; repository_id: string; definition_commit: string; target: TargetBranch;
  path: string; observed_at: string; observation: "local_tracking" | "refreshed";
  status: "planned";
}
export interface SourceIdentity { commit: string; parents: string[] }
export const branchGit = (cwd: string, args: string[]): Buffer => runGitWithEnv(cwd,
  ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
  { ...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith("GIT_")).map(k => [k, undefined])),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, 120_000);
export const validateDevelopment = (value: DevelopmentIdentity): void => {
  if (!value || value.format !== "grounds.development-branch/v1" || !isUUIDv7(value.workspace_id) ||
    typeof value.branch !== "string" || !/^grounds\/[\p{L}\p{N}._/-]+$/u.test(value.branch) || value.branch.includes("..") || value.branch.endsWith("/") || value.branch.length > 1024 || Object.keys(value).sort().join(",") !== "branch,format,workspace_id") throw validation("development", "invalid managed branch identity");
};
export const developmentPath = (root: string, identity: DevelopmentIdentity): string => join(repositoryDataRoot(root), "development", identity.workspace_id, "worktree");
function ensureDevelopmentRoot(root: string): void {
  for (const path of [repositoryDataRoot(root), join(repositoryDataRoot(root), "development")]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw worktreeMismatch("", "managed development root is occupied or symlinked; preserve its contents");
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  ensureGroundsExcluded(root);
}
export function createDevelopmentPlan(root: string, plan: DevelopmentPlan): DevelopmentPlan {
  ensureDevelopmentRoot(root);
  validateDevelopment({ format: plan.format, workspace_id: plan.workspace_id, branch: plan.branch });
  if (!isGitOID(plan.definition_commit) || !isUUIDv7(plan.repository_id) || !isUUIDv7(plan.database_id) || resolve(plan.path) !== developmentPath(root, plan)) throw validation("plan", "plan identity or managed path is invalid");
  branchGit(root, ["check-ref-format", "--branch", plan.branch]);
  const directory = join(repositoryDataRoot(root), "development", plan.workspace_id);
  const file = join(directory, "plan.json");
  if (existsSync(file)) {
    const prior = readDevelopmentPlan(root, plan.workspace_id, plan.database_id);
    const { observed_at: _old, ...a } = prior, { observed_at: _new, ...b } = plan;
    if (sha256(a) !== sha256(b)) throw validation("plan", "operation identity already belongs to a different plan");
    return prior;
  }
  const parts = plan.branch.split("/");
  if (parts.length !== 3 || parts[2] !== plan.workspace_id || developmentBranchName(parts[1], plan.workspace_id) !== plan.branch) throw validation("branch", "new managed branch must be grounds/<readable-issue-slug>/<workspace-id>");
  if (existsSync(directory)) throw worktreeMismatch("", "planned directory is occupied; preserve its contents");
  if (historyGit(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n").includes(`refs/heads/${plan.branch}`)) throw worktreeMismatch("", "planned branch is occupied");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicPrivateWrite(file, JSON.stringify(plan)); return plan;
}
export function readDevelopmentPlan(root: string, id: string, database: string): DevelopmentPlan {
  if (!isUUIDv7(id)) throw validation("plan", "requires a UUIDv7");
  for (const path of [repositoryDataRoot(root), join(repositoryDataRoot(root), "development"), join(repositoryDataRoot(root), "development", id)]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw validation("plan", "managed plan directory is missing, occupied or symlinked");
  }
  const plan = JSON.parse(safeRead(join(repositoryDataRoot(root), "development", id, "plan.json")).toString()) as DevelopmentPlan;
  validateDevelopment({ format: plan.format, workspace_id: plan.workspace_id, branch: plan.branch });
  if (plan.workspace_id !== id || plan.database_id !== database || plan.path !== developmentPath(root, plan)) throw validation("plan", "plan belongs to another database or managed location");
  return plan;
}
export function validateSourceIdentity(value: SourceIdentity): void {
  if (!value || Object.keys(value).sort().join(",") !== "commit,parents" || !isGitOID(value.commit) || !Array.isArray(value.parents) || value.parents.length > 32 || value.parents.some(p => !isGitOID(p)) || new Set(value.parents).size !== value.parents.length) throw validation("source", "invalid fixed source commit and ordered parents");
}
export function assertDevelopmentBranch(cwd: string, identity: DevelopmentIdentity, root?: string): void {
  validateDevelopment(identity); assertHistoryRepository(cwd);
  const common = resolve(historyGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const gitDirectory = resolve(historyGit(cwd, ["rev-parse", "--absolute-git-dir"]));
  if (!lstatSync(join(cwd, ".git")).isFile() || lstatSync(join(cwd, ".git")).isSymbolicLink() || realpathSync(cwd) !== resolve(cwd) || !gitDirectory.startsWith(join(common, "worktrees") + sep) ||
      resolve(safeRead(join(gitDirectory, "gitdir")).toString().trim()) !== resolve(cwd, ".git") ||
      !historyGit(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0").includes(`worktree ${resolve(cwd)}`)) throw worktreeMismatch("", "development directory is not the recorded registered Git worktree; preserve its contents");
  if (historyGit(cwd, ["symbolic-ref", "-q", "HEAD"]) !== `refs/heads/${identity.branch}`) throw worktreeMismatch("", "managed development branch changed; preserve work and restore the recorded branch explicitly");
  if (root && resolve(historyGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== resolve(historyGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))) throw worktreeMismatch("", "worktree belongs to another Git common directory");
}
const UNFINISHED_OPERATION_MARKERS = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
/** One Git process resolves every marker; a path containing a newline cannot be split, so fall back to one call each. */
export function unfinishedOperationPaths(cwd: string): string[] {
  const batched = historyGit(cwd, ["rev-parse", ...UNFINISHED_OPERATION_MARKERS.flatMap(name => ["--git-path", name])]).split("\n");
  const raw = batched.length === UNFINISHED_OPERATION_MARKERS.length && batched.every(Boolean) ? batched
    : UNFINISHED_OPERATION_MARKERS.map(name => historyGit(cwd, ["rev-parse", "--git-path", name]));
  return raw.map(path => resolve(cwd, path));
}
export function assertCommittedDevelopment(cwd: string, identity: DevelopmentIdentity): SourceIdentity {
  assertDevelopmentBranch(cwd, identity);
  if (unfinishedOperationPaths(cwd).some(path => existsSync(path))) throw worktreeMismatch("", "unfinished Git operation; complete or explicitly abandon it before archiving");
  if (historyGit(cwd, ["ls-files", "-u", "-z"])) throw worktreeMismatch("", "unmerged index entries cannot be archived");
  if (historyGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw worktreeMismatch("", "uncommitted tracked or new files; commit the authorized changes before archiving");
  const head = readCommit(cwd, resolveBaseline(cwd, "HEAD")); return { commit: head.oid, parents: head.parents };
}
export function captureCommittedDevelopment(cwd: string, identity: DevelopmentIdentity, base: string, canonicalGitProjection: boolean | "external-runtime" = false): { artifact: CandidateArtifact; source: SourceIdentity } {
  const source = assertCommittedDevelopment(cwd, identity);
  if (!historyGit(cwd, ["rev-list", rawOID(source.commit)]).split("\n").includes(rawOID(base))) throw worktreeMismatch("", "logical base is not contained in the managed source history");
  const index = resolve(cwd, historyGit(cwd, ["rev-parse", "--git-path", "index"]));
  const bytes = existsSync(index) ? readFileSync(index) : undefined;
  if (canonicalGitProjection) {
    // Preserve the existing capture boundary even though the projection itself
    // now reads immutable objects instead of staging the active working tree.
    assertNoTrackedGroundsRuntime(cwd);
    let ignored = false;
    try { historyGit(cwd, ["check-ignore", "-q", "--no-index", ".grounds/.capture-probe"]); ignored = true; } catch { /* fail closed below */ }
    if (!ignored && canonicalGitProjection !== "external-runtime") throw worktreeMismatch("", ".grounds must be ignored before Candidate capture");
    let sparse = false;
    try { sparse = historyGit(cwd, ["config", "--bool", "core.sparseCheckout"]) === "true"; } catch { /* absent is the default */ }
    if (sparse) throw worktreeMismatch("", "sparse checkout is not supported for Candidate capture");
    assertCapturableSubmodules(cwd, rawOID(base), (root, args) => historyBytes(root, args));
  }
  const artifact = canonicalGitProjection ? captureCommittedArtifact(cwd, base, source.commit) : captureArtifact(cwd, base);
  if (artifact.result_tree_oid !== readCommit(cwd, source.commit).tree_oid || assertCommittedDevelopment(cwd, identity).commit !== source.commit ||
    (bytes && (!existsSync(index) || !readFileSync(index).equals(bytes)))) throw worktreeMismatch("", "HEAD, index or files changed during capture; retain files and retry");
  return { artifact, source };
}
export function retainCandidateSource(cwd: string, candidate: string, source: SourceIdentity): void {
  if (!isUUIDv7(candidate) || !isGitOID(source.commit)) throw validation("source", "invalid Candidate source identity");
  const ref = `refs/grounds/candidates/${candidate}`;
  const entry = historyGit(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", ref]).split("\n").find(row => row.startsWith(ref + " "));
  const current = entry ? resolveBaseline(cwd, ref) : undefined;
  if (current && current !== source.commit) throw worktreeMismatch("", "Candidate retention ref was rewritten; do not follow its new value");
  if (!current) branchGit(cwd, ["update-ref", ref, rawOID(source.commit), "0".repeat(rawOID(source.commit).length)]);
  if (resolveBaseline(cwd, ref) !== source.commit) throw worktreeMismatch("", "Candidate retention ref differs from SQL source");
}
export function inspectCandidateSource(cwd: string, candidate: string, source?: SourceIdentity, expectedTree?: string): { status: "unknown" | "present" | "missing" | "inconsistent"; commit?: string } {
  if (!source) return { status: "unknown" };
  const ref = `refs/grounds/candidates/${candidate}`;
  try {
    const refs = historyGit(cwd, ["for-each-ref", "--format=%(refname)", ref]).split("\n");
    if (!refs.includes(ref)) return { status: "missing", commit: source.commit };
    const commit = resolveBaseline(cwd, ref); return { status: commit === source.commit && JSON.stringify(readCommit(cwd, commit).parents) === JSON.stringify(source.parents) && (!expectedTree || readCommit(cwd, commit).tree_oid === expectedTree) ? "present" : "inconsistent", commit };
  } catch { return { status: "unknown", commit: source.commit }; }
}

/** Existing route identity supplies uniqueness; no separate user-maintained name is introduced. */
export function developmentBranchName(issueSlug: string, workspaceId: string): string {
  if (!isUUIDv7(workspaceId)) throw validation("workspace_id", "requires UUIDv7");
  if (!/^[\x00-\x7f]+$/.test(issueSlug)) throw validation("issue_slug", "requires a readable English description using ASCII characters");
  const slug = issueSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72).replace(/-$/, "");
  if (!slug) throw validation("issue_slug", "requires at least one ASCII letter or digit");
  return `grounds/${slug}/${workspaceId}`;
}

/** Reject active configuration before any Git command discovers an untrusted task repo. */
export function assertIndependentTaskSource(source: string): void {
  const metadata = join(resolve(source), ".git");
  if (!lstatSync(metadata).isDirectory() || lstatSync(metadata).isSymbolicLink()) throw worktreeMismatch("", "task source must have ordinary Git metadata");
  const inspect = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw worktreeMismatch("", "task Git metadata must not contain symlinks or special files");
    if (entry.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
  };
  inspect(metadata);
  if (existsSync(join(metadata, "commondir")) || existsSync(join(metadata, "objects", "info", "alternates"))) throw worktreeMismatch("", "task Git metadata must not reference external storage");
  const config = branchGit(dirname(resolve(source)), ["config", "--file", join(metadata, "config"), "--no-includes", "--null", "--list"]).toString("utf8");
  const passive = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|autocrlf|safecrlf)|extensions\.objectformat|user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch|tagopt)|branch\.[^.]+\.(?:remote|merge))$/;
  for (const entry of config.split("\0").filter(Boolean)) {
    const key = entry.slice(0, entry.indexOf("\n"));
    if (!passive.test(key)) throw worktreeMismatch("", `task Git configuration is unsupported at the handoff boundary: ${key}`);
  }
}
const safeSourceFetch = (target: string, source: string, commit: string): void => {
  branchGit(target, ["fetch", "--no-tags", "--no-write-fetch-head", "--upload-pack=git -c core.hooksPath=/dev/null -c 'uploadpack.packObjectsHook=exec ' upload-pack", "--", resolve(source), rawOID(commit)]);
};

/** Receive one fixed commit from an ordinary independent repository into a managed route. */
export function receiveDevelopmentSource(input: { target_path: string; development: DevelopmentIdentity; source_path: string; source_commit: string; expected_head: string }): SourceIdentity {
  const { target_path: target, source_path: source, development, source_commit: commit, expected_head: expected } = input;
  if (!isGitOID(commit) || !isGitOID(expected)) throw validation("source", "fixed source and expected managed HEAD required");
  assertIndependentTaskSource(source);
  assertHistoryRepository(source);
  if (!lstatSync(join(source, ".git")).isDirectory() || lstatSync(join(source, ".git")).isSymbolicLink() ||
      resolve(historyGit(source, ["rev-parse", "--absolute-git-dir"])) !== resolve(source, ".git") ||
      resolve(historyGit(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== resolve(source, ".git") ||
      lstatSync(join(source, ".git", "objects")).isSymbolicLink() || existsSync(join(source, ".git", "objects", "info", "alternates"))) throw worktreeMismatch("", "task source must be an independent ordinary Git repository");
  if (historyGit(source, ["symbolic-ref", "-q", "HEAD"]) !== `refs/heads/${development.branch}` || resolveBaseline(source, "HEAD") !== commit ||
      unfinishedOperationPaths(source).some(path => existsSync(path)) || historyGit(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw worktreeMismatch("", "task source changed or has unfinished work; preserve it");
  assertNoTrackedGroundsRuntime(source);
  const fixed = readCommit(source, commit);
  const before = assertCommittedDevelopment(target, development);
  if (before.commit !== expected && before.commit !== commit) throw worktreeMismatch("", "managed route HEAD changed since task preparation; preserve both repositories");
  safeSourceFetch(target, source, commit);
  const received = readCommit(target, commit);
  if (received.tree_oid !== fixed.tree_oid || JSON.stringify(received.parents) !== JSON.stringify(fixed.parents)) throw worktreeMismatch("", "received source identity differs from fixed task output");
  if (before.commit === commit) return { commit, parents: fixed.parents };
  branchGit(target, ["merge-base", "--is-ancestor", rawOID(expected), rawOID(commit)]);
  if (assertCommittedDevelopment(target, development).commit !== expected) throw worktreeMismatch("", "managed route changed during source reception");
  // Publish only against the prepared HEAD. A failed checkout or interruption leaves the
  // independent source and target files available for explicit recovery; never reset them.
  branchGit(target, ["update-ref", `refs/heads/${development.branch}`, rawOID(commit), rawOID(expected)]);
  branchGit(target, ["read-tree", "-u", "-m", rawOID(expected), rawOID(commit)]);
  const after = assertCommittedDevelopment(target, development);
  if (after.commit !== commit) throw worktreeMismatch("", "managed route did not accept the fixed output");
  return after;
}

/** Persist the exact output outside the task repository, without changing any checked-out branch. */
export function receiveDevelopmentObjects(input: { target_path: string; source_path: string; source_commit: string; environment_id: string }): { source_commit: string; tree: string; parents: string[]; ref: string } {
  const { target_path: target, source_path: source, source_commit: commit, environment_id: id } = input;
  if (!isGitOID(commit) || !isUUIDv7(id)) throw validation("source", "fixed source commit and environment UUIDv7 required");
  assertIndependentTaskSource(source);
  assertHistoryRepository(source); assertHistoryRepository(target);
  if (resolve(source) === resolve(target) || !lstatSync(join(source, ".git")).isDirectory() || lstatSync(join(source, ".git")).isSymbolicLink() ||
      resolve(historyGit(source, ["rev-parse", "--absolute-git-dir"])) !== resolve(source, ".git") ||
      resolve(historyGit(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !== resolve(source, ".git") ||
      lstatSync(join(source, ".git", "objects")).isSymbolicLink() || existsSync(join(source, ".git", "objects", "info", "alternates"))) throw worktreeMismatch("", "task source must be an independent ordinary Git repository");
  assertNoTrackedGroundsRuntime(source);
  if (historyBytes(source, ["ls-tree", "-r", "--name-only", "-z", rawOID(commit), "--", ".grounds"]).toString("utf8").split("\0").some(isPrivateGroundsPath)) throw worktreeMismatch("", "fixed task source tracks private Grounds runtime files");
  const fixed = readCommit(source, commit), ref = `refs/grounds/environment/${id}`;
  const prior = historyGit(target, ["for-each-ref", "--format=%(refname) %(objectname)", ref]).split("\n").find(line => line.startsWith(ref + " "));
  if (prior && prior !== `${ref} ${rawOID(commit)}`) throw worktreeMismatch("", "environment output retention identity already belongs to another commit");
  safeSourceFetch(target, source, commit);
  const received = readCommit(target, commit);
  if (received.tree_oid !== fixed.tree_oid || JSON.stringify(received.parents) !== JSON.stringify(fixed.parents)) throw worktreeMismatch("", "received source identity differs from fixed task output");
  if (!prior) branchGit(target, ["update-ref", ref, rawOID(commit), "0".repeat(rawOID(commit).length)]);
  if (resolveBaseline(target, ref) !== commit) throw worktreeMismatch("", "environment output retention changed during handoff");
  return { source_commit: commit, tree: fixed.tree_oid, parents: fixed.parents, ref };
}

/** Fixed Git capture also serves pinned evaluation and ordinary non-managed repositories. */
export function captureCommittedCandidate(cwd: string, base: string): { artifact: CandidateArtifact; source: SourceIdentity } {
  assertHistoryRepository(cwd);
  if (unfinishedOperationPaths(cwd).some(path => existsSync(path)) || historyGit(cwd, ["ls-files", "-u", "-z"]) || historyGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw worktreeMismatch("", "Candidate capture requires committed files and no unfinished Git operation; preserve existing work");
  assertNoTrackedGroundsRuntime(cwd);
  const fixed = readCommit(cwd, resolveBaseline(cwd, "HEAD"));
  branchGit(cwd, ["merge-base", "--is-ancestor", rawOID(base), rawOID(fixed.oid)]);
  const artifact = captureCommittedArtifact(cwd, base, fixed.oid);
  if (resolveBaseline(cwd, "HEAD") !== fixed.oid || historyGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw worktreeMismatch("", "source changed during capture; preserve it and retry");
  return { artifact, source: { commit: fixed.oid, parents: fixed.parents } };
}
