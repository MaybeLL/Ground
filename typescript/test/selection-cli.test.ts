import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { execute, runCLI, commandNeedsOperationID, parseArgs } from "../src/cli.js";
import { DomainError } from "../src/errors.js";
import { SQLStore } from "../src/sql-store.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { captureArtifact, materializeCandidateWorktree, writeDeliveryReceipt } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import type { CandidateSubmissionV2Input } from "../src/domain.js";
import type { DeliveryReceipt, SelectionResult } from "../src/selection.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { assertContract } from "./schema-fixture.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("Selection CLI prepares the chosen immutable Candidate and preserves the delivery snapshot after reselection", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-selection-cli-"))); const repo = join(root, "source"); const config = join(root, "config.yaml");
  const localCLI: typeof runCLI = (args, options) => withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => runCLI(args, options));
  let f: LedgerFixture | undefined;
  try {
    execFileSync("git", ["init", "-q", repo]); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.test"); git(repo, "remote", "add", "origin", "ssh://git@example.test/team/repo");
    writeFileSync(join(repo, ".git/info/exclude"), "/.grounds/\n"); writeFileSync(join(repo, "file.txt"), "before\n"); git(repo, "add", "-A"); git(repo, "commit", "-m", "base");
    const baseline = `sha1:${git(repo, "rev-parse", "HEAD")}`;
    const db = join(root, "db");
    await execute(["init", "--driver", "sqlite", "--path", db, "--config", config, "--non-interactive", "--json"], { cwd: root });
    f = await LedgerFixture.createWithStore(SQLStore.sqlite(db));
    const remote = join(root, "remote.git"); git(root, "init", "--bare", "-q", remote); git(repo, "push", remote, "HEAD:refs/heads/main");
    const transport = archiveCLITransport(t, root, remote, f.repository.repository_id);
    const issue = await f.module.reviseIssue({ operation_id: newUUIDv7(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "local fixture", override_reason: "local fixture" }, input: { format: 1, summary: "Real artifact", goals: [{ statement: "Change file", criteria: ["File changes"] }] }, attribution: testAgent });
    const candidates: string[] = [];
    const artifacts: ReturnType<typeof captureArtifact>[] = [];
    for (const content of ["first", "second"]) {
      const started: string[] = [];
      const startCode = await localCLI(["devrun", "start", "--development-mode", "simple", "--issue", f.issue.issue_id, "--legacy-fixed", "--config", config, "--json", "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name], { cwd: repo, stdout: line => started.push(line), stderr: () => {} });
      const startEnvelope = JSON.parse(started.join("\n")); assert.equal(startCode, 0, JSON.stringify(startEnvelope));
      const run = { result: startEnvelope.data }, worktree = startEnvelope.data.local_worktree.path;
      writeFileSync(join(worktree, "file.txt"), `${content}\n`);
      git(worktree, "add", "-A"); git(worktree, "commit", "-qm", "fixed candidate");
      const artifact = captureArtifact(worktree, baseline); artifacts.push(artifact);
      const draft = (await f.module.candidateSubmissionTemplate(run.result.context.dev_run.id, artifact)).submission as CandidateSubmissionV2Input;
      draft.explanation = `Implement ${content}`;
      for (const claim of draft.claims) { claim.explanation = "Changes file"; for (const criterion of claim.criteria) criterion.explanation = "Inspected file"; }
      for (const rationale of draft.change_rationales) { rationale.target_refs = [{ type: "criterion", id: draft.claims[0].criteria[0].criterion_id }]; rationale.rationale = "Use the reviewed wording"; rationale.alternatives = []; rationale.risks = []; }
      const form = join(root, `submission-${content}.json`); writeFileSync(form, JSON.stringify(draft));
      const output: string[] = [];
      const code = await localCLI(["candidate", "submit", run.result.context.dev_run.id, "--expected-version", "1", "--file", form, "--archive-policy", transport.policy(), "--config", config, "--json", "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name], { cwd: repo, stdout: line => output.push(line), stderr: () => {} });
      const submitted = JSON.parse(output.join("\n")); assert.equal(code, 0, JSON.stringify(submitted)); candidates.push(submitted.data.candidate_id);
    }
    git(repo, "reset", "--hard", baseline.slice(5));
    const invoke = async (args: string[]) => {
      const output: string[] = [];
      const code = await localCLI([...args, ...(args.includes("--config") ? [] : ["--config", config]), "--json"], { cwd: repo, stdout: line => output.push(line), stderr: () => {} });
      const envelope = JSON.parse(output[0]); assertContract("cli-envelope.schema.json", envelope);
      if (code === 0) assertContract("command-results.schema.json", envelope.data); else assertContract("error.schema.json", envelope.error);
      return { code, envelope };
    };
    const base = ["--issue", f.issue.issue_id, "--issue-version", "2"];
    const empty = await invoke(["selection", "show", ...base]); assert.equal(empty.envelope.data.selection.version, 0);
    const missingPath = join(root, "no-choice");
    assert.equal((await invoke(["selection", "materialize", ...base, "--expected-version", "0", "--path", missingPath])).code, 4); assert.equal(existsSync(missingPath), false);
    assert.equal((await invoke(["selection", "set", ...base, "--candidate", candidates[0], "--reason", "Reviewed"])).code, 2);
    const selected = await invoke(["selection", "set", ...base, "--candidate", candidates[0], "--expected-version", "0", "--reason", "Reviewed"]);
    assert.equal(selected.code, 0); assert.ok(selected.envelope.operation_id);
    const before = selected.envelope.data as SelectionResult;
    const target = join(root, "delivery");
    assert.equal((await invoke(["selection", "materialize", ...base, "--expected-version", "0", "--path", target])).code, 4); assert.equal(existsSync(target), false);
    const delivered = await invoke(["selection", "materialize", ...base, "--expected-version", "1", "--path", target]);
    assert.equal(delivered.code, 0, JSON.stringify(delivered)); assert.equal(readFileSync(join(target, "file.txt"), "utf8"), "first\n");
    const receipt = JSON.parse(readFileSync(delivered.envelope.data.receipt_path, "utf8")) as DeliveryReceipt; assertContract("delivery-worktree.schema.json", receipt);
    assert.equal(receipt.selection_id, before.selection.id); assert.equal(receipt.selection_version, 1); assert.equal(receipt.candidate_id, candidates[0]);
    assert.equal(delivered.envelope.data.receipt_path, resolve(target, git(target, "rev-parse", "--git-path", "grounds-delivery.json")));
    assert.equal(captureArtifact(target, baseline).result_tree_oid, receipt.result_tree_oid);
    const retry = await invoke(["selection", "materialize", ...base, "--expected-version", "1", "--path", target]);
    assert.equal(retry.code, 0); assert.deepEqual(retry.envelope.data.receipt, receipt);
    const inspected = await invoke(["selection", "inspect", ...base]);
    assert.equal(inspected.code, 0); assert.equal(inspected.envelope.data.worktrees[0].status, "ready");
    rmSync(delivered.envelope.data.receipt_path);
    const incomplete = await invoke(["selection", "inspect", ...base, "--path", target]);
    assert.equal(incomplete.envelope.data.worktrees[0].next_action, "resume_preparation");
    assert.equal((await invoke(incomplete.envelope.data.worktrees[0].recommended_argv)).code, 0);
    const changed = await invoke(["selection", "set", ...base, "--candidate", candidates[1], "--expected-version", "1", "--reason", "Prefer second"]); assert.equal(changed.code, 0);
    const staleInspection = await invoke(["selection", "inspect", ...base, "--path", target]);
    assert.equal(staleInspection.envelope.data.worktrees[0].selection_changed, true);
    assert.equal(staleInspection.envelope.data.worktrees[0].next_action, "review_selection");
    const staleRetry = await invoke(["selection", "materialize", ...base, "--expected-version", "1", "--path", target]);
    assert.equal(staleRetry.code, 4); assert.equal(staleRetry.envelope.error.details.target_path, target);
    assert.equal((await invoke(staleRetry.envelope.error.details.inspect_argv)).code, 0);
    assert.equal(readFileSync(join(target, "file.txt"), "utf8"), "first\n"); assert.deepEqual(JSON.parse(readFileSync(delivered.envelope.data.receipt_path, "utf8")), receipt);
    assert.equal((await invoke(["selection", "materialize", ...base, "--expected-version", "2", "--path", target])).code, 6);
    const second = await invoke(["selection", "materialize", ...base, "--expected-version", "2", "--path", join(root, "second"), "--branch", "chosen-second"]); assert.equal(second.code, 0); assert.equal(second.envelope.data.branch, "chosen-second");
    assert.equal((await invoke(["selection", "clear", ...base, "--expected-version", "2"])).code, 0);
    assert.equal(readFileSync(join(target, "file.txt"), "utf8"), "first\n");
    const explicit = await invoke(["candidate", "materialize", candidates[0], "--mode", "delivery", "--path", join(root, "explicit"), "--branch", "explicit-candidate"]); assert.equal(explicit.code, 0);
    assert.equal((await f.module.showSelection(f.issue.issue_id, 2)).selection.state, "unselected");

    // Force receipt rename to fail after a real worktree is created. Source
    // and the new worktree must survive; no false success is returned.
    const failurePath = join(root, "receipt-failure");
    materializeCandidateWorktree({ source_path: repo, source_commit: receipt.source_commit, target_path: failurePath, mode: "delivery", branch: "receipt-failure", baseline_oid: baseline, patch: artifacts[0].patch, expected_tree_oid: artifacts[0].result_tree_oid });
    mkdirSync(resolve(failurePath, git(failurePath, "rev-parse", "--git-path", "grounds-delivery.json")));
    assert.throws(() => writeDeliveryReceipt(failurePath, receipt), (error: unknown) => { assert.ok(error instanceof DomainError); assert.equal(error.code, "WORKTREE_MISMATCH"); assert.match(String(error.details.reason), /directory is retained/); assertContract("error.schema.json", error.toJSON()); return true; });
    assert.equal(readFileSync(join(failurePath, "file.txt"), "utf8"), "first\n");
  } finally { await f?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Selection help and operation identity distinguish writes from pinned delivery", async () => {
  assert.equal(commandNeedsOperationID(parseArgs(["selection", "set"])), true);
  assert.equal(commandNeedsOperationID(parseArgs(["selection", "clear"])), true);
  assert.equal(commandNeedsOperationID(parseArgs(["selection", "materialize"])), false);
  for (const action of ["show", "set", "clear", "materialize", "inspect"]) {
    const result = await execute(["selection", action, "--help", "--json"]); assertContract("command-results.schema.json", result);
  }
});
