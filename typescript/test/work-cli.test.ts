import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execute, runCLI } from "../src/cli.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { validateGrade } from "../src/work/domain/index.js";
import { parseGrade } from "../src/work/entry/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

interface Harness { cli(...args: string[]): Promise<{ code: number; ok: boolean; data: any; error: any; stderr: string[] }>; repo: string; remote: string; directory: string; baseline: string }

async function withHarness(run: (h: Harness) => Promise<void>, objectFormat: "sha1" | "sha256" = "sha1"): Promise<void> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "grounds-work-cli-")));
  try {
    const repo = join(directory, "repo"), remote = join(directory, "remote.git");
    execFileSync("git", ["init", "-q", `--object-format=${objectFormat}`, "--bare", remote]);
    execFileSync("git", ["init", "-q", `--object-format=${objectFormat}`, "-b", "main", repo]);
    writeFileSync(join(repo, "app.txt"), "v0\n");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    const baseline = git(repo, "rev-parse", "HEAD");
    const config = join(directory, "config.yaml"), db = join(directory, "ledger.db");
    await withRuntimeDirectories({ runtimeHome: join(directory, "runtime"), directoryRegistryHome: join(directory, "registry") }, async () => {
      await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", db]);
      const cli: Harness["cli"] = async (...args) => {
        const lines: string[] = [], errors: string[] = [];
        const code = await runCLI([...args, "--json", "--config", config, "--cwd", repo], { stdout: l => lines.push(l), stderr: l => errors.push(l) });
        const envelope = JSON.parse(lines[lines.length - 1]!);
        if (envelope.ok) assertContract("cli-envelope.schema.json", envelope);
        return { code, ok: envelope.ok, data: envelope.data, error: envelope.error, stderr: errors };
      };
      await run({ cli, repo, remote, directory, baseline });
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const gradeFile = (directory: string, name: string, criteria: Array<{ criterion_id: string; final: string }>) => {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify({ criteria: criteria.map(c => ({ criterion_id: c.criterion_id, independent: c.final, reconciliation: "corroborated", final: c.final, rationale: "checked", evidence: ["ran the tests"] })) }));
  assertContract("grade-input.schema.json", JSON.parse(readFileSync(path, "utf8")));
  return path;
};
const ok = (r: { ok: boolean; data: any; error: any }) => { assert.ok(r.ok, JSON.stringify(r.error)); return r.data; };

test("the caller's own agent works a task end to end through the command line: deliver, be rejected, refine from the delivery, be accepted", async () => {
  await withHarness(async h => {
    const created = ok(await h.cli("task", "create", "--title", "Add export", "--criterion", "exports CSV", "--criterion", "keeps headers", "--repo-remote", h.remote, "--baseline", h.baseline));
    for (const [command, payload] of [["task.create", created], ["task.revise", created], ["grade.request", { gradingId: "g", requestSeq: 1, taskRunId: "r" }]] as const) {
      assert.throws(() => assertContract("work-results.schema.json", { ...payload, command, result_type: `grounds.result.${command}/v1`, criteria: [{ id: "c", statement: "" }] }));
    }
    const criteria = created.criteria as { id: string }[];
    const started = ok(await h.cli("work", "start", "--task", created.taskId, "--mode", "external"));

    // First round: a worktree at the baseline, work, deliver.
    const space = ok(await h.cli("work", "workspace", "--run", started.runId));
    assert.equal(space.base.from, "baseline");
    assert.equal(git(space.path, "rev-parse", "HEAD"), h.baseline);
    const worker = ok(await h.cli("work", "register", "--run", started.runId, "--agent", "claude-code"));
    ok(await h.cli("work", "transcript", "--run", started.runId, "--session", worker.sessionId, "--ref", "session.log", "--digest", `sha256:${"a".repeat(64)}`, "--coverage", "partial"));
    writeFileSync(join(space.path, "app.txt"), "v1\n"); git(space.path, "commit", "-qam", "export csv");
    const first = ok(await h.cli("work", "deliver", "--run", started.runId, "--session", worker.sessionId, "--repo", space.path, "--declare-stop"));
    assert.equal(first.submitted.status, "delivered");
    for (const invalid of [{ outcome: "unknown" }, { blocked: "unknown" }]) {
      assert.throws(() => assertContract("work-results.schema.json", { ...first, submitted: { ...first.submitted, ...invalid } }));
    }
    assert.throws(() => assertContract("work-results.schema.json", { ...first, command: "work.start" }));
    assert.throws(() => assertContract("work-results.schema.json", { ...first, submitted: { ...first.submitted, status: "unknown" } }));
    assert.equal(git(h.remote.replace(/\/$/, ""), "rev-parse", `refs/tags/grounds/deliveries/${first.delivery.id}`), git(space.path, "rev-parse", "HEAD"), "the commit is archived on the remote");

    // An independent evaluator rejects it.
    const gate = ok(await h.cli("grade", "request", "--run", started.runId));
    assert.deepEqual(gate.criteria.map((c: { id: string }) => c.id).sort(), criteria.map(c => c.id).sort());
    const evaluator = ok(await h.cli("grade", "register", "--grading", gate.gradingId, "--agent", "reviewer"));
    assert.notEqual(evaluator.sessionId, worker.sessionId);
    ok(await h.cli("grade", "stage", "--grading", gate.gradingId, "--session", evaluator.sessionId, "--stage", "blind"));
    const verdict = gradeFile(h.directory, "g1.json", [{ criterion_id: criteria[0]!.id, final: "satisfied" }, { criterion_id: criteria[1]!.id, final: "unsatisfied" }]);
    const blindDigest = `sha256:${createHash("sha256").update(readFileSync(verdict)).digest("hex")}`;
    ok(await h.cli("grade", "stage", "--grading", gate.gradingId, "--session", evaluator.sessionId, "--stage", "freeze", "--blind-digest", blindDigest));
    // Exercise every stage documented by the direct-CLI skill. These are fake
    // external sessions, not evidence that a real host isolated an evaluator.
    for (const stage of ["reconcile", "handoff", "submit"]) {
      ok(await h.cli("grade", "stage", "--grading", gate.gradingId, "--session", evaluator.sessionId, "--stage", stage));
    }
    ok(await h.cli("grade", "command", "--grading", gate.gradingId, "--session", evaluator.sessionId, "--stage", "reconcile",
      "--entry", "git diff", "--argv-digest", blindDigest, "--state", "succeeded", "--exit-code", "0"));
    const recorded = ok(await h.cli("grade", "show", "--grading", gate.gradingId));
    assert.deepEqual(recorded.evaluator.protocol.map((s: { stage: string }) => s.stage), ["blind", "freeze", "reconcile", "handoff", "submit"]);
    assert.equal(recorded.evaluator.protocol[1].blindDigest, blindDigest);
    assert.equal(ok(await h.cli("grade", "submit", "--grading", gate.gradingId, "--session", evaluator.sessionId, "--grade-file", verdict)).status, "completed");
    assert.equal(ok(await h.cli("work", "show", "--work", started.workId)).conclusion, "rejected");

    // Refinement starts from what was delivered, in a new worktree.
    const next = ok(await h.cli("work", "continue", "--work", started.workId, "--expected-head", started.runId, "--mode", "external"));
    const space2 = ok(await h.cli("work", "workspace", "--run", next.runId));
    assert.equal(space2.base.from, "delivery");
    assert.notEqual(space2.path, space.path, "a new worktree, not the old one");
    assert.equal(git(space2.path, "rev-parse", "HEAD"), first.delivery.commit);
    assert.equal(readFileSync(join(space2.path, "app.txt"), "utf8"), "v1\n");
    const worker2 = ok(await h.cli("work", "register", "--run", next.runId, "--agent", "claude-code"));
    writeFileSync(join(space2.path, "app.txt"), "v2\n"); git(space2.path, "commit", "-qam", "keep headers");
    ok(await h.cli("work", "deliver", "--run", next.runId, "--session", worker2.sessionId, "--repo", space2.path, "--declare-stop"));
    const gate2 = ok(await h.cli("grade", "request", "--run", next.runId));
    const evaluator2 = ok(await h.cli("grade", "register", "--grading", gate2.gradingId, "--agent", "reviewer"));
    for (const [stage, extra] of [["blind", []], ["freeze", ["--blind-digest", `sha256:${"b".repeat(64)}`]]] as const) ok(await h.cli("grade", "stage", "--grading", gate2.gradingId, "--session", evaluator2.sessionId, "--stage", stage, ...extra));
    ok(await h.cli("grade", "submit", "--grading", gate2.gradingId, "--session", evaluator2.sessionId, "--grade-file", gradeFile(h.directory, "g2.json", criteria.map(c => ({ criterion_id: c.id, final: "satisfied" })))));
    const view = ok(await h.cli("work", "show", "--work", started.workId));
    assert.equal(view.conclusion, "accepted");
    assert.equal(view.work.head, next.runId);
    assert.equal(ok(await h.cli("work", "run", "--run", started.runId)).acceptance, "rejected", "the first delivery keeps its own verdict");
    assert.deepEqual(ok(await h.cli("grade", "list", "--run", started.runId)).gates.map((g: { id: string }) => g.id), [gate.gradingId]);
    const abandoned = ok(await h.cli("grade", "request", "--run", started.runId));
    const otherEvaluator = ok(await h.cli("grade", "register", "--grading", abandoned.gradingId, "--agent", "second-reviewer"));
    ok(await h.cli("grade", "cancel", "--grading", abandoned.gradingId));
    assert.equal(ok(await h.cli("grade", "stop", "--grading", abandoned.gradingId, "--session", otherEvaluator.sessionId)).status, "cancelled");
    const branch = ok(await h.cli("work", "branch", "--work", started.workId, "--refines", started.runId, "--mode", "external"));
    ok(await h.cli("work", "select", "--work", started.workId, "--run", branch.runId));
    const otherWorker = ok(await h.cli("work", "register", "--run", branch.runId, "--agent", "branch-worker"));
    ok(await h.cli("work", "cancel", "--run", branch.runId));
    assert.equal(ok(await h.cli("work", "stop", "--run", branch.runId, "--session", otherWorker.sessionId, "--reason", "abandoned")).status, "cancelled");
    ok(await h.cli("work", "select", "--work", started.workId, "--run", next.runId));
    const closed = ok(await h.cli("work", "close", "--work", started.workId));
    assert.deepEqual([closed.status, closed.conclusion], ["closed", "accepted"]);
  });
});

for (const objectFormat of ["sha1", "sha256"] as const) test(`the skill checks out a ${objectFormat} delivery using the actual overridden remote despite the opposite Git default`, async () => {
  await withHarness(async h => {
    const actualRemote = join(h.directory, "delivery-remote.git");
    execFileSync("git", ["init", "-q", `--object-format=${objectFormat}`, "--bare", actualRemote]);
    const task = ok(await h.cli("task", "create", "--title", "Export", "--criterion", "exports CSV", "--repo-remote", h.remote, "--baseline", h.baseline));
    const started = ok(await h.cli("work", "start", "--task", task.taskId, "--mode", "external"));
    const worker = ok(await h.cli("work", "register", "--run", started.runId, "--agent", "worker"));
    const space = ok(await h.cli("work", "workspace", "--run", started.runId));
    writeFileSync(join(space.path, "app.txt"), "frozen delivery\n");
    git(space.path, "commit", "-qam", "deliver");
    const delivered = ok(await h.cli("work", "deliver", "--run", started.runId, "--session", worker.sessionId,
      "--repo", space.path, "--remote", actualRemote, "--commit", git(space.path, "rev-parse", "HEAD"), "--declare-stop"));
    const run = ok(await h.cli("work", "run", "--run", started.runId)).run;
    assert.equal(delivered.submitted.status, "delivered");
    assert.equal(run.manifest.items.find((item: { id: string }) => item.id === delivered.delivery.id)?.receipt, delivered.delivery.receipt);
    writeFileSync(join(space.path, "app.txt"), "uncommitted worker changes\n");

    // Execute the distributed instructions, not an internal receipt decoder or
    // archive adapter. Installation tests prove source/bundle Markdown parity.
    const guide = readFileSync(new URL("../../plugins/grounds/skills/grounds/references/workflows/verify.md", import.meta.url), "utf8");
    const checkout = /```bash\n(# Frozen delivery checkout\n[\s\S]*?)\n```/.exec(guide)?.[1];
    assert.ok(checkout, "the skill contains an executable checkout recipe");
    const materialize = (directory: string, remote = actualRemote, commit = delivered.delivery.commit) => execFileSync("bash", ["-c", checkout], {
      cwd: h.directory, encoding: "utf8", stdio: "pipe", env: { ...process.env,
        GIT_DEFAULT_HASH: objectFormat === "sha1" ? "sha256" : "sha1",
        DELIVERY_REMOTE: remote, DELIVERY_ID: delivered.delivery.id, DELIVERY_COMMIT: commit, REVIEW_DIR: directory },
    });
    const review = join(h.directory, "independent-review");
    materialize(review);
    assert.equal(git(review, "rev-parse", "HEAD"), delivered.delivery.commit);
    assert.equal(git(review, "rev-parse", "--show-object-format"), objectFormat);
    for (const invalid of ["A".repeat(40), "z".repeat(64), "a".repeat(41)]) {
      const invalidDirectory = join(h.directory, `invalid-${invalid}`);
      assert.throws(() => materialize(invalidDirectory, actualRemote, invalid));
      assert.equal(existsSync(invalidDirectory), false, "invalid OIDs fail before creating a directory");
    }
    assert.throws(() => git(review, "symbolic-ref", "-q", "HEAD"), "checkout must be detached");
    assert.equal(git(review, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(review, "app.txt"), "utf8"), "frozen delivery\n");
    assert.throws(() => materialize(join(h.directory, "wrong-remote"), h.remote), "never fall back to the task remote");
    assert.throws(() => materialize(review), "never overwrite an existing review directory");
    assert.equal(readFileSync(join(review, "app.txt"), "utf8"), "frozen delivery\n");

    const gate = ok(await h.cli("grade", "request", "--run", started.runId));
    const evaluator = ok(await h.cli("grade", "register", "--grading", gate.gradingId, "--agent", "fresh-reviewer"));
    assert.notEqual(evaluator.sessionId, worker.sessionId);
    // A moved tag must fail closed even though its old commit remains available.
    git(actualRemote, "update-ref", `refs/tags/grounds/deliveries/${delivered.delivery.id}`, h.baseline);
    assert.throws(() => materialize(join(h.directory, "moved-tag")));
  }, objectFormat);
});

test("a call is safe to repeat with its operation id, and a delivery interrupted after the archive is simply run again", async () => {
  await withHarness(async h => {
    const created = ok(await h.cli("task", "create", "--title", "Add export", "--criterion", "exports CSV", "--repo-remote", h.remote, "--baseline", h.baseline));
    const operation = newUUIDv7();
    const started = ok(await h.cli("work", "start", "--task", created.taskId, "--mode", "none", "--operation-id", operation));
    assert.deepEqual(ok(await h.cli("work", "start", "--task", created.taskId, "--mode", "none", "--operation-id", operation)), started);
    const conflict = await h.cli("work", "start", "--task", created.taskId, "--mode", "external", "--operation-id", operation);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "IDEMPOTENCY_CONFLICT");

    const space = ok(await h.cli("work", "workspace", "--run", started.runId));
    writeFileSync(join(space.path, "app.txt"), "v1\n"); git(space.path, "commit", "-qam", "change");
    // The interruption: the archive was written, the delivery was never submitted.
    const commit = git(space.path, "rev-parse", "HEAD");
    git(space.path, "push", "-q", h.remote, `${commit}:refs/tags/grounds/deliveries/d-${started.runId}-${commit.slice(0, 12)}`);
    const delivered = ok(await h.cli("work", "deliver", "--run", started.runId, "--repo", space.path));
    assert.equal(delivered.submitted.status, "delivered", "running it again found the tag in place and submitted");
    assert.equal(delivered.delivery.commit, commit);
    // Delivering again changes nothing: the round is over, and the late submission is only recorded.
    const again = ok(await h.cli("work", "deliver", "--run", started.runId, "--repo", space.path));
    assert.deepEqual([again.submitted.status, again.submitted.outcome], ["delivered", "late"]);
    const run = ok(await h.cli("work", "run", "--run", started.runId)).run;
    assert.equal(run.manifest.items[0].id, delivered.delivery.id);
    assert.equal(run.lateRecords.length, 1);
  });
});

test("refusals are structured, and nothing is written for them", async () => {
  await withHarness(async h => {
    const missing = await h.cli("work", "start", "--task", "no-such-task", "--mode", "external");
    assert.deepEqual([missing.ok, missing.error.code, missing.code], [false, "NOT_FOUND", 3]);
    const noCriteria = await h.cli("task", "create", "--title", "x");
    assert.equal(noCriteria.error.code, "VALIDATION_ERROR");
    const noMode = await h.cli("work", "start", "--task", "t");
    assert.equal(noMode.error.code, "VALIDATION_ERROR");
    assert.deepEqual(ok(await h.cli("task", "list")).tasks, []);
    const unknown = await h.cli("work", "dance");
    assert.equal(unknown.error.code, "VALIDATION_ERROR");
    assert.match(ok(await h.cli("work", "help")).usage, /grounds work deliver/);
  });
});

test("a task revision keeps the criteria it names and the work started before keeps its wording", async () => {
  await withHarness(async h => {
    const first = ok(await h.cli("task", "create", "--title", "Add export", "--criterion", "exports CSV", "--criterion", "keeps headers"));
    const keep = first.criteria[0];
    const revised = ok(await h.cli("task", "revise", "--task", first.taskId, "--expected-seq", "1", "--title", "Add export", "--criterion", `${keep.id}: exports CSV with a BOM`, "--criterion", "streams large files"));
    assert.equal(revised.seq, 2);
    assert.equal(revised.criteria[0].id, keep.id);
    assert.equal(ok(await h.cli("task", "show", "--task", first.taskId, "--revision", "1")).revision.id, first.revisionId);
    const stale = await h.cli("task", "revise", "--task", first.taskId, "--expected-seq", "1", "--title", "x", "--criterion", "y");
    assert.equal(stale.error.code, "STATE_CONFLICT");
  });
});

test("a grade file is checked before anything is sent", () => {
  const reason = (value: unknown) => { try { parseGrade(value); } catch (error) { return (error as { details?: { reason?: string } }).details?.reason ?? ""; } return "accepted"; };
  assert.match(reason({}), /criteria/);
  assert.match(reason({ criteria: [null] }), /each criterion/);
  assert.throws(() => assertContract("grade-input.schema.json", { criteria: [null] }));
  assert.match(reason({ criteria: [{ criterion_id: "c", independent: "maybe", reconciliation: "corroborated", final: "satisfied", rationale: "r" }] }), /each criterion/);
  assert.match(reason({ criteria: [{ criterion_id: "c", independent: "satisfied", reconciliation: "corroborated", final: "satisfied", rationale: "r", evidence: [1] }] }), /evidence/);
  const grade = parseGrade({ criteria: [{ criterion_id: "c", independent: "satisfied", reconciliation: "corroborated", final: "satisfied", rationale: "r" }] });
  assert.deepEqual(grade.form === "criteria" && grade.items[0]!.evidence, []);
});

test("grade input and domain share Unicode length limits for criterion IDs and rationales", () => {
  for (const [idLength, reasonLength, valid] of [[128, 4096, true], [129, 4096, false], [128, 4097, false]] as const) {
    const input = { criteria: [{ criterion_id: "🙂".repeat(idLength), rationale: "🙂".repeat(reasonLength), independent: "satisfied", reconciliation: "corroborated", final: "satisfied" }] };
    if (valid) assertContract("grade-input.schema.json", input);
    else assert.throws(() => assertContract("grade-input.schema.json", input));
    assert.equal(validateGrade(parseGrade(input), { form: "criteria" }).ok, valid);
  }
});
