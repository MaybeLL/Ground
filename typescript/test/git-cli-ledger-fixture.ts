import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runCLI } from "../src/cli.js";
import { newUUIDv7 } from "../src/identity.js";
import { captureCommittedArtifact, resolveBaseline } from "../src/git.js";
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { LedgerFixture, testAgent, type CandidateFixture } from "./fixture.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";

/** Real local Git objects and archive wire protocol for tests crossing the CLI/store boundary. */
export async function gitCLICandidate(t: { after(f: () => void): void }, root: string, config: string, fixture: LedgerFixture): Promise<CandidateFixture & { repository: string }> {
  const repository = join(root, "repository"), remote = join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(root, "init", "--bare", "-q", remote); git(root, "init", "-qb", "main", repository);
  git(repository, "config", "user.name", "CLI Test"); git(repository, "config", "user.email", "test@invalid");
  git(repository, "remote", "add", "origin", fixture.repository.canonical_remote);
  writeFileSync(join(repository, ".gitignore"), ".grounds/*\n!.grounds/environments/\n");
  writeFileSync(join(repository, "file-one"), "base\n"); git(repository, "add", "-A"); git(repository, "commit", "-qm", "base");
  const base = resolveBaseline(repository, "HEAD"); git(repository, "push", remote, "HEAD:refs/heads/main");
  const transport = archiveCLITransport(t, root, remote, fixture.repository.repository_id, fixture.repository.canonical_remote);
  const revision = await fixture.module.reviseIssue({ operation_id: newUUIDv7(), attribution: testAgent, issue_id: fixture.issue.issue_id, expected_predecessor_id: (await fixture.module.currentIssueRevision(fixture.issue.issue_id)).id, requirement_revision_id: fixture.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: base, reachability: "unconfirmed", warning: "isolated test", override_reason: "isolated test Git baseline" }, input: { format: 1, summary: "Implement the change", goals: [{ statement: "Change behavior", criteria: ["The behavior changes"] }] } });
  async function invoke(...args: string[]) {
    const output: string[] = [];
    const code = await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => runCLI([...args, "--config", config, "--json"], { cwd: repository, stdout: value => output.push(value), stderr: () => {} }));
    const envelope = JSON.parse(output.join("\n")); assert.equal(code, 0, JSON.stringify(envelope)); return envelope.data;
  }
  const started = await invoke("devrun", "start", "--issue", fixture.issue.issue_id, "--legacy-fixed", "--development-mode", "simple");
  const path = started.local_worktree.path;
  writeFileSync(join(path, "file-one"), Array.from({ length: 20 }, (_, i) => `feature line ${i + 1}\n`).join(""));
  git(path, "add", "file-one"); git(path, "commit", "-qm", "candidate");
  const template = await fixture.module.candidateSubmissionTemplate(started.context.dev_run.id);
  const submission = template.submission;
  submission.explanation = "Implemented behavior";
  for (const claim of submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Verified"; }
  const file = join(root, "candidate-submission.json"); writeFileSync(file, JSON.stringify(submission));
  const candidate = await invoke("candidate", "submit", "--dev-run", started.context.dev_run.id, "--expected-version", "1", "--file", file, "--archive-policy", transport.policy());
  const artifact = captureCommittedArtifact(repository, base, candidate.source.commit);
  fixture.store.setGitArtifactResolver(ref => deriveLocalGitArtifact(repository, ref.git_artifact!.binding));
  return { repository, run: { context: started.context } as CandidateFixture["run"], candidate, artifact, submission, goal_id: started.context.issue.goals[0].id, criterion_id: started.context.issue.goals[0].criteria[0].id };
}
