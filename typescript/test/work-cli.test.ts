import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execute, openStore, runCLI } from "../src/cli.js";
import { signalHostProcessLeader } from "../src/env-process.js";
import { dataLayout } from "../src/data-layout.js";
import { hostDirectory } from "../src/managed-host-client.js";
import { withRuntimeDirectories, withRuntimeLock } from "../src/runtime-files.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { validateGrade } from "../src/work/domain/index.js";
import { parseGrade, workHelp } from "../src/work/entry/index.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function checkoutRecipe(): string {
  const guide = readFileSync(new URL("../../plugins/grounds/skills/grounds/references/workflows/verify.md", import.meta.url), "utf8");
  const checkout = /```bash\n(# Frozen delivery checkout\n[\s\S]*?)\n```/.exec(guide)?.[1];
  assert.ok(checkout, "the skill contains an executable checkout recipe");
  return checkout;
}

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
        assertContract("cli-envelope.schema.json", envelope);
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
    const first = ok(await h.cli("work", "deliver", "--run", started.runId, "--session", worker.sessionId, "--repo", space.path, "--declare-stop", "--protection", "protected", "--protection-evidence", "admin/rules/7"));
    assert.equal(first.submitted.status, "delivered");
    const observed = ok(await h.cli("work", "run", "--run", started.runId)).archiveIntegrity;
    assert.equal(observed[0].status, "intact");
    assert.equal(observed[0].recordedCommit, first.delivery.commit);
    assert.deepEqual(observed[0].protection, { level: "protected", evidence: "admin/rules/7" });
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
    const checkout = checkoutRecipe();
    const materialize = (directory: string, remote = actualRemote, commit = delivered.delivery.commit) => execFileSync("bash", ["-c", checkout], {
      cwd: h.directory, encoding: "utf8", stdio: "pipe", env: { ...process.env,
        GIT_DEFAULT_HASH: objectFormat === "sha1" ? "sha256" : "sha1",
        ACTIVE_ARCHIVE_ID: "", DELIVERY_REMOTE: remote, DELIVERY_ID: delivered.delivery.id, DELIVERY_COMMIT: commit, REVIEW_DIR: directory },
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
  const base = { criterion_id: "c", independent: "satisfied", reconciliation: "corroborated", final: "satisfied", rationale: "r" };
  for (const [field, allowed] of [
    ["independent", ["satisfied", "unsatisfied", "indeterminate"]],
    ["final", ["satisfied", "unsatisfied", "indeterminate"]],
    ["reconciliation", ["corroborated", "contradicted", "not_determined"]],
  ] as const) {
    const diagnostic = reason({ criteria: [{ ...base, [field]: "unsupported" }] });
    assert.ok(diagnostic.includes(allowed.join(", ")));
    assert.ok(workHelp().includes(allowed.join(" | ")));
  }
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

test("work repair publishes a separate archive and exposes the original beside the active receipt", async () => {
  await withHarness(async h => {
    const task = ok(await h.cli("task", "create", "--title", "Archive fixture", "--criterion", "Preserve commit", "--repo-remote", h.remote, "--baseline", h.baseline));
    const { workId, runId } = ok(await h.cli("work", "start", "--task", task.taskId, "--mode", "none"));
    const { delivery } = ok(await h.cli("work", "deliver", "--run", runId, "--repo", h.repo));
    const gate = ok(await h.cli("grade", "request", "--run", runId));
    git(h.remote, "update-ref", "-d", `refs/tags/grounds/deliveries/${delivery.id}`);
    git(h.remote, "reflog", "expire", "--expire=now", "--all"); git(h.remote, "gc", "--prune=now");
    const args = ["work", "repair", "--run", runId, "--delivery", delivery.id, "--repo", h.repo];
    const db = new DatabaseSync(join(h.directory, "ledger.db"));
    try {
      db.exec("CREATE TRIGGER interrupt_repair BEFORE UPDATE ON work_intents WHEN NEW.kind='repair-archive' AND NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'injected interruption'); END");
      assert.equal((await h.cli(...args)).ok, false);
      db.exec("DROP TRIGGER interrupt_repair");
    } finally { db.close(); }
    const recovery = ok(await h.cli("work", "reconcile", "--run", runId));
    assertContract("work-results.schema.json", recovery);
    assert.equal(recovery.confirmed.length, 1);
    const repair = recovery.confirmed[0];
    assert.deepEqual(ok(await h.cli(...args, "--operation-id", repair.requestId)).repair, repair);
    const materialize = (id: string, directory: string) => execFileSync("bash", ["-c", checkoutRecipe()], {
      cwd: h.directory, stdio: "pipe", env: { ...process.env, ACTIVE_ARCHIVE_ID: id, DELIVERY_ID: delivery.id,
        DELIVERY_COMMIT: h.baseline, DELIVERY_REMOTE: h.remote, REVIEW_DIR: directory },
    });
    const checkout = join(h.directory, "repaired-review");
    materialize(repair.archiveId, checkout);
    assert.equal(git(checkout, "rev-parse", "HEAD"), h.baseline);
    assert.throws(() => materialize(delivery.id, join(h.directory, "stale-review")));
    assert.equal(repair.commit, h.baseline);
    assert.notEqual(repair.archiveId, delivery.id);
    for (const data of [ok(await h.cli("work", "show", "--work", workId)), ok(await h.cli("grade", "show", "--grading", gate.gradingId)), ok(await h.cli("grade", "list", "--run", runId))]) {
      const [current] = data.archiveIntegrity;
      assert.equal(current.activeArchiveId, repair.archiveId);
      assert.equal(current.original.tag, "missing");
      assert.equal(current.status, "intact");
      assert.equal(current.repairs[0].receipt, repair.receipt);
      assertContract("work-results.schema.json", data);
      const incomplete = { ...current };
      delete incomplete.original;
      assert.throws(() => assertContract("work-results.schema.json", { ...data, archiveIntegrity: [incomplete] }));
      assert.throws(() => assertContract("work-results.schema.json", { ...data, archiveIntegrity: [{ ...current, repairs: [repair] }] }));
    }
  });
});

test("20 historical runs become an immutable suite with traceable private materials and repeatable rule measurements", async () => {
  await withHarness(async h => {
    const cases = [];
    const taskRevisions = [];
    const rule = ok(await h.cli("grade", "define-rule", "--name", "Required output", "--rule", "file-exists", "--pass", "present", "--fail", "absent"));
    for (let i = 0; i < 20; i++) {
      const task = ok(await h.cli("task", "create", "--title", "Render sample " + i, "--criterion", "Render the fixture", "--repo-remote", h.remote, "--baseline", h.baseline));
      taskRevisions.push(task.revisionId);
      const { runId } = ok(await h.cli("work", "start", "--task", task.taskId, "--mode", "none"));
      writeFileSync(join(h.repo, "reference.txt"), "sample " + i);
      writeFileSync(join(h.repo, "answer.txt"), i === 19 ? Buffer.alloc(1048577, 65) : i % 2 ? "incorrect" : "sample " + i);
      git(h.repo, "add", "-A"); git(h.repo, "commit", "-qm", "sample " + i);
      const { delivery } = ok(await h.cli("work", "deliver", "--run", runId, "--repo", h.repo));
      if (i === 0) {
        git(h.remote, "update-ref", "-d", "refs/tags/grounds/deliveries/" + delivery.id);
        ok(await h.cli("work", "repair", "--run", runId, "--delivery", delivery.id, "--repo", h.repo));
      }
      cases.push({ key: "case-" + i, runId, deliveryId: delivery.id, bindings: [
        { key: "compare", answerPath: "answer.txt", referencePath: "reference.txt", hiddenTestPaths: [] as string[] },
        { key: "present", answerPath: "answer.txt", grader: { definitionId: rule.graderId, revisionId: rule.revisionId } },
      ] });
      if (i === 0) {
        writeFileSync(join(h.repo, "private-test.js"), "assert(output === expected);");
        git(h.repo, "add", "-A"); git(h.repo, "commit", "-qm", "curator adds a hidden test after delivery");
        const curator = ok(await h.cli("work", "start", "--task", task.taskId, "--mode", "none"));
        const extra = ok(await h.cli("work", "deliver", "--run", curator.runId, "--repo", h.repo));
        Object.assign(cases[0]!.bindings[0]!, { materialSource: { runId: curator.runId, deliveryId: extra.delivery.id }, hiddenTestPaths: ["private-test.js"] });
      }
    }
    const path = join(h.directory, "cases.json");
    writeFileSync(path, JSON.stringify(cases));
    const publish = ["suite", "publish", "--name", "Fixture suite", "--cases-file", path, "--operation-id", newUUIDv7()];
    const snapshot = ok(await h.cli(...publish));
    assert.equal(snapshot.caseCount, 20);
    assert.deepEqual(ok(await h.cli(...publish)), snapshot);
    for (const extra of [{ grader: { definitionId: rule.graderId, revisionId: rule.revisionId, ignored: true } },
      { materialSource: { runId: cases[0]!.runId, deliveryId: cases[0]!.deliveryId, ignored: true } }]) {
      writeFileSync(path, JSON.stringify([{ ...cases[0], bindings: [{ ...cases[0]!.bindings[0], ...extra }] }]));
      assert.equal((await h.cli(...publish)).error.code, "VALIDATION_ERROR");
    }
    writeFileSync(path, JSON.stringify(cases));
    const show = ["suite", "show", "--suite", snapshot.suiteId, "--revision", "1"];
    const first = ok(await h.cli(...show));
    assert.equal(first.suite.digest, snapshot.digest);
    assert.equal(first.cases.length, 20);
    assert.equal(first.cases[0].bindings[0].materials[1].role, "hidden-test");
    assert.equal(JSON.stringify(first).includes("base64"), false);
    for (let i = 0; i < cases.length; i++) {
      const original = cases[i]!, frozen = first.cases[i];
      assert.equal(frozen.source.runId, original.runId);
      assert.equal(frozen.source.deliveryId, original.deliveryId);
      assert.equal(frozen.taskRevision.revisionId, taskRevisions[i]);
      const expected = "sha256:" + createHash("sha256").update("sample " + i).digest("hex");
      assert.equal(frozen.bindings[0].materials[0].digest, expected);
      const args = ["suite", "measure", "--suite", snapshot.suiteId, "--revision", "1", "--case", original.key, "--binding", "compare", "--run", original.runId, "--delivery", original.deliveryId];
      const measured = ok(await h.cli(...args));
      assert.equal(measured.result, i % 2 ? "mismatch" : "match");
      assert.equal(measured.expectedDigest, expected);
      const record = ok(await h.cli("grade", "show", "--grading", measured.gradingId));
      assert.deepEqual(record.origin.historical, { taskRunId: original.runId, caseKey: original.key, bindingKey: "compare", suite: first.suite });
      assert.equal(record.purpose, "measure"); assert.equal(record.grade.category, measured.result);
      const repeated = ok(await h.cli(...args));
      assert.notEqual(repeated.gradingId, measured.gradingId);
      assert.equal(repeated.actualDigest, measured.actualDigest); assert.equal(repeated.result, measured.result);
    }
    assert.notEqual(first.cases[0].source.archiveReceipt, first.cases[0].source.receipt);
    assert.notEqual(first.cases[0].source.archiveId, first.cases[0].source.deliveryId);
    assert.notEqual(first.cases[0].bindings[0].materialSource.runId, first.cases[0].source.runId);
    const presence = ok(await h.cli("suite", "measure", "--suite", snapshot.suiteId, "--revision", "1", "--case", cases[0]!.key, "--binding", "present", "--run", cases[0]!.runId, "--delivery", cases[0]!.deliveryId));
    assert.equal(presence.result, "present"); assert.equal(presence.expectedDigest, null);
    writeFileSync(path, JSON.stringify(cases.slice(0, 1)));
    const revised = ok(await h.cli("suite", "publish", "--suite", snapshot.suiteId, "--expected-seq", "1", "--name", "Revised suite", "--cases-file", path));
    assert.equal(revised.seq, 2);
    assert.equal(ok(await h.cli("suite", "list")).suites[0].name, "Revised suite");
    assert.equal(first.name, "Fixture suite");
    assert.deepEqual(ok(await h.cli(...show)), first);
    assert.equal(ok(await h.cli("suite", "list")).suites[0].head.seq, 2);
  });
});

test("a standalone measure scores a historical candidate against an explicit reference without a suite", async () => {
  await withHarness(async h => {
    const task = ok(await h.cli("task", "create", "--title", "fixture", "--criterion", "write answer", "--repo-remote", h.remote, "--baseline", h.baseline));
    const { runId } = ok(await h.cli("work", "start", "--task", task.taskId, "--mode", "none"));
    const { delivery } = ok(await h.cli("work", "deliver", "--run", runId, "--repo", h.repo));
    const rule = ok(await h.cli("grade", "define-rule", "--name", "Output", "--rule", "equal-file-bytes", "--pass", "yes", "--fail", "no"));
    const args = ["grade", "measure", "--run", runId, "--delivery", delivery.id, "--grader", rule.graderId, "--grader-revision", rule.revisionId, "--answer-path", "app.txt"];
    assert.equal((await h.cli(...args)).ok, false);
    const presence = ok(await h.cli("grade", "define-rule", "--name", "Presence", "--rule", "file-exists", "--pass", "yes", "--fail", "no"));
    const presenceArgs = ["grade","measure","--run",runId,"--delivery",delivery.id,"--answer-path","app.txt","--grader",presence.graderId,"--grader-revision",presence.revisionId];
    for (const option of ["--reference-path", "--reference-path=", "--reference-run", "--reference-delivery"]) {
      assert.equal((await h.cli(...presenceArgs, option)).error.code, "VALIDATION_ERROR");
    }
    writeFileSync(join(h.repo, "app.txt"), "curated answer");
    git(h.repo, "commit", "-qam", "reference");
    const curator = ok(await h.cli("work","start","--task",task.taskId,"--mode","none"));
    const reference = ok(await h.cli("work","deliver","--run",curator.runId,"--repo",h.repo)).delivery;
    git(h.remote, "update-ref", "-d", "refs/tags/grounds/deliveries/" + reference.id);
    const { repair } = ok(await h.cli("work","repair","--run",curator.runId,"--delivery",reference.id,"--repo",h.repo));
    args.push("--reference-run", curator.runId, "--reference-delivery", reference.id, "--reference-path", "app.txt");
    const op = newUUIDv7();
    const score = ok(await h.cli(...args, "--operation-id", op));
    assert.equal(score.result, "no");
    assert.equal(score.actualDigest, "sha256:" + createHash("sha256").update("v0\n").digest("hex"));
    assert.equal(score.expectedDigest, "sha256:" + createHash("sha256").update("curated answer").digest("hex"));
    const saved = ok(await h.cli("grade", "show", "--grading", score.gradingId));
    assert.equal(saved.origin.direct.reference.deliveryId, reference.id);
    assert.equal(saved.origin.direct.reference.archive.originalReceipt, reference.receipt);
    assert.equal(saved.origin.direct.reference.archive.archiveId, repair.archiveId);
    assert.equal(saved.origin.direct.reference.archive.archiveReceipt, repair.receipt);
    assert.equal(saved.origin.direct.archive.archiveReceipt, delivery.receipt);
    assert.equal(saved.origin.direct.reference.digest, score.expectedDigest);
    assert.equal(saved.origin.direct.actualDigest, score.actualDigest);
    assert.deepEqual(ok(await h.cli("suite", "list")).suites, []);
    rmSync(h.remote, { recursive: true, force: true });
    assert.deepEqual(ok(await h.cli(...args, "--operation-id", op)), score);
    assert.equal((await h.cli(...args)).ok, false);
  });
});

test("an environment requirement resolves once per run to the latest or a specified revision", async () => {
  await withHarness(async h => {
    const config = join(h.directory,"devcontainer.json"), lock = join(h.directory,".devcontainer-lock.json");
    const digest = "sha256:" + "1".repeat(64);
    writeFileSync(config, '{ // operator config\n"image":"alpine@' + digest + '",}');
    writeFileSync(lock, "{}\n");
    const args = ["work","define-environment","--name","CI","--devcontainer",config,"--lockfile",lock,"--image-digest",digest];
    const first = ok(await h.cli(...args));
    const task = ok(await h.cli("task","create","--title","target","--criterion","works","--environment",first.environmentId));
    const start = ["work","start","--mode","none","--task",task.taskId];
    const initial = ok(await h.cli(...start));
    writeFileSync(config,'{"image":"alpine@' + digest + '","name":"second"}');
    const second = ok(await h.cli(...args,"--environment",first.environmentId,"--expected-seq","1"));
    const latest = ok(await h.cli(...start));
    const specified = ok(await h.cli(...start,"--environment-revision",first.revisionId));
    for (const [run,revision,source] of [[initial,first,"latest"],[latest,second,"latest"],[specified,first,"specified"]]) {
      const recorded = ok(await h.cli("work","run","--run",run.runId)).run.environment;
      assert.equal(recorded.revision.revisionId, revision.revisionId);
      assert.equal(recorded.source, source);
    }
    const shown = ok(await h.cli("work","environment","--environment",first.environmentId,"--revision","1"));
    assert.equal(shown.content.lockfileDigest, "sha256:" + createHash("sha256").update("{}\n").digest("hex"));
    assert.equal((await h.cli(...start,"--environment-revision","missing")).ok,false);
  });
});

test("three ledger-backed task sandboxes survive a receipt interruption and isolate their workspace and lifecycle", { skip: !process.env.GROUNDS_TEST_DEVCONTAINER && "requires local Docker and a shared data root" }, async () => {
  await withHarness(async h => {
    const docker = (...args: string[]) => execFileSync("docker",args,{encoding:"utf8"}).trim();
    const image = docker("image","inspect","--format","{{index .RepoDigests 0}}",process.env.GROUNDS_TEST_CONTAINER_IMAGE ?? "alpine:latest");
    const config = join(h.directory,"devcontainer.json");
    writeFileSync(config, JSON.stringify({image, remoteUser:"nobody", workspaceFolder:"/work", workspaceMount:"source=${localWorkspaceFolder},target=/work,type=bind"}));
    const env = ok(await h.cli("work","define-environment","--name","isolated","--image-digest",image.split("@")[1]!,"--devcontainer",config));
    const task = ok(await h.cli("task","create","--title","runtime test","--criterion","isolated","--environment",env.environmentId,"--baseline",h.baseline,"--repo-remote",h.remote));
    const runs = await Promise.all(Array.from({length:3}, async () => ok(await h.cli("work","start","--task",task.taskId,"--mode","external")).runId as string));
    const ledger = new DatabaseSync(join(h.directory, "ledger.db"));
    const ledgerId = ledger.prepare("SELECT database_id FROM schema_metadata").get()!.database_id as string;
    try {
      ledger.exec("CREATE TRIGGER interrupt_runtime BEFORE UPDATE ON work_intents WHEN NEW.kind='launch-devcontainer' AND NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'crash after local receipt'); END");
      const outcomes = await Promise.all(runs.map(run => h.cli("work","prepare-sandbox","--run",run,"--repo",h.repo)));
      assert.ok(outcomes.every(o => !o.ok));
      const before = docker("ps","--no-trunc","--format","{{.ID}}","--filter","label=dev.grounds.ledger="+ledgerId).split("\n").sort();
      assert.equal(before.length,3);
      ledger.exec("DROP TRIGGER interrupt_runtime");
      const sandboxes = await Promise.all(runs.map(async run => ok(await h.cli("work","reconcile-sandbox","--run",run))));
      assert.deepEqual(sandboxes.map(s => s.instanceId).sort(),before);
      for (const s of sandboxes) {
        docker("exec",s.instanceId,"sh","-c",'printf %s "$1" > /work/result',"sh",s.runId);
        assert.equal(s.commit,h.baseline); assert.equal(s.environmentRevisionId,env.revisionId);
      }
      for (const s of sandboxes) assert.equal(docker("exec",s.instanceId,"cat","/work/result"),s.runId);
      const first = sandboxes[0]!, second = sandboxes[1]!;
      assert.equal((await h.cli("work","release-sandbox","--run",first.runId)).ok,false);
      const firstRun = ok(await h.cli("work","run","--run",first.runId)).run;
      ok(await h.cli("work","cancel","--run",first.runId));
      assert.equal(docker("inspect","--format","{{.State.Paused}}",first.instanceId),"true");
      assert.equal(docker("inspect","--format","{{.State.Paused}}",second.instanceId),"false");
      assert.equal(ok(await h.cli("work","close","--work",firstRun.workId)).status,"closed");
      for (const s of sandboxes.slice(1)) {
        ok(await h.cli("work","cancel","--run",s.runId));
        assert.equal(ok(await h.cli("work","release-sandbox","--run",s.runId)).phase,"released");
      }
      assert.equal(docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledgerId),"");
    } finally {
      ledger.close();
      for (const id of docker("ps","-aq","--no-trunc","--filter","label=dev.grounds.ledger="+ledgerId).split("\n").filter(Boolean)) docker("rm","-f",id);
    }
  });
});

test("invalid devcontainer inputs cannot replace the image or mount another task's workspace", async () => {
  await withHarness(async h => {
    const config = join(h.directory,"devcontainer.json");
    const digest = "sha256:" + "1".repeat(64);
    for (const input of [{image:"alpine@sha256:"+"2".repeat(64)}, {image:"alpine",workspaceMount:"source=shared,target=/work,type=volume"},
      {image:"alpine",mounts:["source=/,target=/host,type=bind"]}, {image:"alpine",runArgs:["-iv","/tmp/shared:/work/shared"]}, {image:"alpine",workspaceFolder:"/"+"a".repeat(10000)+"!"}]) {
      writeFileSync(config,JSON.stringify(input));
      const out = await h.cli("work","define-environment","--name","wrong","--devcontainer",config,"--image-digest",digest);
      assert.equal(out.error.code,"VALIDATION_ERROR");
    }
  });
});

test("killing the preparing CLI leaves one verified container and the launch helper's durable receipt", { skip: !process.env.GROUNDS_TEST_DEVCONTAINER && "requires Docker" }, async () => {
  await withHarness(async h => {
    const { spawn } = await import("node:child_process");
    const { setTimeout: wait } = await import("node:timers/promises");
    const docker = (...args: string[]) => execFileSync("docker",args,{encoding:"utf8"}).trim();
    const image = docker("image","inspect","--format","{{index .RepoDigests 0}}",process.env.GROUNDS_TEST_CONTAINER_IMAGE ?? "alpine:latest");
    const config = join(h.directory,"devcontainer.json");
    writeFileSync(config,JSON.stringify({image,workspaceFolder:"/work",
      postCreateCommand:"printf x >> /work/launch-count; while [ ! -f /work/go ]; do sleep 0.1; done"}));
    const env = ok(await h.cli("work","define-environment","--name","interrupted setup","--image-digest",image.split("@")[1]!,"--devcontainer",config));
    const task = ok(await h.cli("task","create","--title","setup","--criterion","start once","--environment",env.environmentId,"--baseline",h.baseline,"--repo-remote",h.remote));
    const {runId,workId} = ok(await h.cli("work","start","--task",task.taskId,"--mode","external"));
    const db = new DatabaseSync(join(h.directory,"ledger.db"));
    const ledgerId = db.prepare("SELECT database_id FROM schema_metadata").get()!.database_id as string;
    db.close();
    const filter = "label=dev.grounds.ledger="+ledgerId;
    const child = spawn(process.execPath,["--import","tsx","src/main.ts","work","prepare-sandbox","--run",runId,"--repo",h.repo,"--config",join(h.directory,"config.yaml"),"--json"],{stdio:"ignore"});
    const ended = new Promise<void>(resolve => child.once("close", () => resolve()));
    const until = async <T>(get: () => Promise<T | undefined>) => {
      const deadline = Date.now()+60_000;
      while (Date.now()<deadline) { const result=await get(); if (result !== undefined) return result; await wait(100); }
      throw new Error("timed out awaiting owned sandbox");
    };
    try {
      const id = await until(async () => {
        const id=docker("ps","--no-trunc","-q","--filter",filter);
        if (!id) return;
        try { if (docker("exec",id,"cat","/work/launch-count")==="x") return id; } catch { /* postCreate has not started */ }
      });
      child.kill("SIGKILL"); await ended;
      assert.equal((await h.cli("work","reconcile-sandbox","--run",runId)).ok,false);
      docker("exec",id,"touch","/work/go");
      const prepared = await until(async () => {
        const response = await h.cli("work","reconcile-sandbox","--run",runId);
        return response.ok ? response.data : undefined;
      });
      assert.equal(prepared.instanceId,id);
      assert.equal(docker("exec",id,"cat","/work/launch-count"),"x");
      ok(await h.cli("work","cancel","--run",runId)); ok(await h.cli("work","close","--work",workId));
      assert.equal(docker("ps","-aq","--filter",filter),"");
    } finally {
      child.kill("SIGKILL"); await ended;
      for (const id of docker("ps","-aq","--no-trunc","--filter",filter).split("\n").filter(Boolean)) docker("rm","-f",id);
    }
  });
});

test("verified local image setup failure retains a paused blocked sandbox that Work can release", { skip: !process.env.GROUNDS_TEST_DEVCONTAINER && "requires Docker" }, async () => {
  await withHarness(async h => {
    const docker = (...args:string[]) => execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    const digest = docker("image","inspect","--format","{{.Id}}",process.env.GROUNDS_TEST_CONTAINER_IMAGE ?? "alpine:latest");
    const config = join(h.directory,"devcontainer.json"), lock = join(h.directory,"devcontainer-lock.json");
    writeFileSync(config,JSON.stringify({image:"local/test-image",postCreateCommand:"exit 31"}));
    writeFileSync(lock,JSON.stringify({features:{}}));
    const env = ok(await h.cli("work","define-environment","--name","local-immutable","--image-digest",digest,"--devcontainer",config,"--lockfile",lock));
    const task = ok(await h.cli("task","create","--title","failed setup","--criterion","isolated","--environment",env.environmentId,"--baseline",h.baseline,"--repo-remote",h.remote));
    const {runId,workId} = ok(await h.cli("work","start","--task",task.taskId,"--mode","external"));
    const db = new DatabaseSync(join(h.directory,"ledger.db"));
    const ledgerId = db.prepare("SELECT database_id FROM schema_metadata").get()!.database_id as string;
    db.close();
    const filter = "label=dev.grounds.ledger="+ledgerId;
    try {
      const failed = await h.cli("work","prepare-sandbox","--run",runId,"--repo",h.repo);
      assert.equal(failed.error.code,"STATE_CONFLICT"); assert.equal(failed.error.retryable,false);
      const run = ok(await h.cli("work","run","--run",runId)).run;
      assert.equal(run.status,"failed"); assert.equal(run.failure.class,"infrastructure");
      const id = docker("ps","--no-trunc","-aq","--filter",filter);
      assert.match(id,/^[a-f0-9]{64}$/);
      assert.equal(docker("inspect","--format","{{.State.Paused}}",id),"true");
      assert.equal((await h.cli("work","reconcile-sandbox","--run",runId)).error.retryable,false);
      ok(await h.cli("work","close","--work",workId));
      assert.equal(docker("ps","-aq","--filter",filter),"");
    } finally {
      for (const id of docker("ps","-aq","--no-trunc","--filter",filter).split("\n").filter(Boolean)) docker("rm","-f",id);
    }
  });
});

test("provider trace import preserves exact raw bytes, normalizes known records, and replays after the file is gone", async () => {
  await withHarness(async h => {
    const task = ok(await h.cli("task","create","--title","Trace","--criterion","reads input","--baseline",h.baseline,"--repo-remote",h.remote));
    const {runId} = ok(await h.cli("work","start","--task",task.taskId,"--mode","external"));
    const {sessionId} = ok(await h.cli("work","register","--run",runId,"--agent","codex"));
    ok(await h.cli("work","deliver","--run",runId,"--repo",h.repo,"--session",sessionId,"--declare-stop"));
    const firstGate = ok(await h.cli("grade","request","--run",runId));
    const file = join(h.directory,"session.jsonl");
    const bytes = Buffer.from([
      JSON.stringify({type:"thread.started",thread_id:"session"}),
      JSON.stringify({type:"unrecognized",padding:"x".repeat(65536)}),
      "malformed",
      JSON.stringify({type:"item.completed",item:{id:"msg",type:"agent_message",text:"finished"}}),
      JSON.stringify({type:"turn.completed"}),
    ].join("\r\n"));
    writeFileSync(file,bytes);
    const digest = "sha256:"+createHash("sha256").update(bytes).digest("hex");
    const args = ["work","import-trace","--file",file,"--provider","codex","--digest",digest,"--run",runId,"--session",sessionId,"--operation-id",newUUIDv7()];
    const imported = ok(await h.cli(...args));
    const trace = imported.trace;
    assert.equal(trace.records,5); assert.equal(trace.eventCount,3); assert.equal(trace.convertedRecords,3);
    assert.equal(trace.raw.chunkCount,2);
    assert.equal(trace.omissions.invalidJson,1); assert.equal(trace.omissions.unknownRecords,1);
    const secondGate = ok(await h.cli("grade","request","--run",runId));
    const before = ok(await h.cli("grade","show","--grading",firstGate.gradingId));
    const after = ok(await h.cli("grade","show","--grading",secondGate.gradingId));
    assert.deepEqual(before.materials,[]);
    assert.deepEqual(after.materials.map((m: {digest:string})=>m.digest),[trace.raw.digest,trace.events.digest]);
    assert.notEqual(before.binding.materialsDigest,after.binding.materialsDigest);
    rmSync(file); assert.deepEqual(ok(await h.cli(...args)),imported);
    const read = async (stream: string, n: number) => Buffer.from(ok(await h.cli("work","trace","--run",runId,"--digest",digest,"--stream",stream,"--chunk",String(n))).base64,"base64");
    assert.deepEqual(Buffer.concat([await read("raw",0),await read("raw",1)]),bytes);
    const events = (await read("events",0)).toString().trim().split("\n").map(line=>JSON.parse(line));
    assert.deepEqual(events.map(e=>e.sourceLine),[1,4,5]);
    assert.equal(events[1].event.text,"finished");
    assert.deepEqual(ok(await h.cli("work","run","--run",runId)).run.worker.registration.transcripts[0].trace,trace);
    const db = new DatabaseSync(join(h.directory,"ledger.db"));
    try {
      db.prepare("DELETE FROM work_evidence_chunks WHERE digest=?").run(digest);
      db.prepare("DELETE FROM work_evidence WHERE digest=?").run(digest);
    } finally { db.close(); }
    const status = ok(await h.cli("db","status"));
    assert.equal(status.integrity.valid,false);
    const other = ok(await h.cli("work","start","--task",task.taskId,"--mode","external"));
    assert.equal((await h.cli("work","trace","--run",other.runId,"--digest",digest,"--stream","raw","--chunk","0")).error.code,"NOT_FOUND");
  });
});

test("managed worker runs in its owned devcontainer after admission and delivers its exact declared commit", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT && "requires the managed agent fixture image"},async()=>{
  await withHarness(async h=>{
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!,digest=docker("image","inspect","--format","{{.Id}}",image);
    const config=join(h.directory,"devcontainer.json");
    writeFileSync(config,JSON.stringify({image,workspaceFolder:"/work"}));
    const env=ok(await h.cli("work","define-environment","--name","worker fixture","--devcontainer",config,"--image-digest",digest));
    const db = new DatabaseSync(join(h.directory, "ledger.db"));
    const ledger = db.prepare("SELECT database_id FROM schema_metadata").get()!.database_id as string;
    db.close();
    const containers = () => docker("ps", "-q", "--filter", "label=dev.grounds.ledger=" + ledger).split("\n").filter(Boolean);
    git(h.repo, "remote", "add", "origin", h.remote);
    const jobs = [];
    const keys = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      for (const provider of ["codex", "claude-code", "codex"]) {
        for (const key of keys) delete process.env[key];
        if (jobs.length === 0) process.env.OPENAI_API_KEY = "synthetic-first";
        if (jobs.length === 1) process.env.ANTHROPIC_API_KEY = "synthetic-second";
        const title = "concurrent fixture " + jobs.length;
        const task = ok(await h.cli("task", "create", "--title", title, "--criterion", "commit result", "--environment", env.environmentId, "--repo-remote", "origin", "--baseline", h.baseline));
        const agent = ok(await h.cli("work", "define-agent", "--name", title, "--provider", provider));
        const args = ["work", "start", "--mode", "managed", "--task", task.taskId, "--agent", agent.agentId, "--repo", h.repo, "--operation-id", newUUIDv7()];
        const started = ok(await h.cli(...args));
        assert.deepEqual(ok(await h.cli(...args)), started);
        jobs.push({ title, started, args });
      }
      const deadline = Date.now() + 90_000;
      const ready = new Map<string,string>();
      while (Date.now() < deadline && ready.size < jobs.length) {
        for (const id of containers()) {
          if (ready.has(id)) continue;
          try { ready.set(id, docker("exec", id, "cat", "/tmp/grounds-fixture-ready")); }
          catch { /* The worker has not reached the barrier yet. */ }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.deepEqual([...ready.values()].sort(), jobs.map(job => job.title));
      const hook = join(h.remote, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n", {mode: 0o755});
      const recovering = jobs[2]!;
      const ticket = JSON.parse(readFileSync(join(hostDirectory("waiting"), recovering.started.executionId), "utf8"));
      assert.equal(signalHostProcessLeader(ticket.pid, ticket.birth, "SIGKILL"), true);
      for (const id of ready.keys()) docker("exec", id, "touch", "/tmp/grounds-fixture-release");
      let recovery;
      do {
        recovery = ok(await h.cli("work", "managed-status", "--run", recovering.started.runId));
        if (recovery.host?.state === "awaiting-resume") break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert.equal(recovery.host?.state, "awaiting-resume", JSON.stringify(recovery));
      const recoveryId = newUUIDv7();
      const resume = ["work", "resume-managed", "--operation-id", recoveryId, "--run"];
      ok(await h.cli(...resume, recovering.started.runId));
      assert.equal((await h.cli(...resume, jobs[0]!.started.runId)).ok, false);
      let archivedDigest = "";
      for (const {started} of jobs) {
        let blocked;
        do {
          blocked = ok(await h.cli("work", "managed-status", "--run", started.runId));
          if (blocked.host?.state === "blocked") break;
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
        assert.equal(blocked.stage, "archive_blocked", JSON.stringify(blocked));
        assert.equal(blocked.stop, "verified");
        archivedDigest = blocked.trace.raw.digest;
        const bytes = ok(await h.cli("work", "trace", "--run", started.runId, "--digest", archivedDigest, "--stream", "raw", "--chunk", "0"));
        assert.ok(Buffer.from(bytes.base64, "base64").length);
      }
      assert.equal(git(h.repo, "ls-remote", "--tags", h.remote), "");
      const lingering = [...ready].find(([, title]) => title === "concurrent fixture 0")![0];
      assert.equal(docker("inspect", "-f", "{{.State.Running}}", lingering), "false");
      rmSync(hook);
      const redirected = join(h.directory, "different.git");
      execFileSync("git", ["init", "--bare", "-q", redirected]);
      git(h.repo, "remote", "set-url", "--push", "origin", redirected);
      // Archived retries can use the frozen database evidence after the
      // collector's original spool has been cleaned up.
      for (const {started} of jobs) {
        const files = join(dataLayout().runtime, "executions", ledger, started.executionId);
        rmSync(join(files, "stdout.jsonl"));
        rmSync(join(files, "stderr"));
      }
      assert.deepEqual(ok(await h.cli(...recovering.args)), recovering.started);
      do {
        recovery = ok(await h.cli("work", "managed-status", "--run", recovering.started.runId));
        if (recovery.host?.detail?.includes("no remote receipt")) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert.match(recovery.host?.detail ?? "", /no remote receipt/);
      assert.equal(git(h.repo, "ls-remote", "--tags", h.remote), "");
      for (const {started} of jobs) ok(await h.cli("work", "resume-managed", "--run", started.runId));
      for (const {title, started} of jobs) {
        let view;
        do {
          view = ok(await h.cli("work", "managed-status", "--run", started.runId));
          if (["delivered", "cancelled", "failed"].includes(view.status)) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
        assert.equal(view.status, "delivered", JSON.stringify(view));
        assert.equal(view.stage, "succeeded");
        assert.equal(view.stop, "verified");
        const {run} = ok(await h.cli("work", "run", "--run", started.runId));
        assert.equal(run.manifest.origin, "contract");
        assert.equal(run.worker.executionId, started.executionId);
        const tag = "refs/tags/grounds/deliveries/" + run.manifest.items[0].id;
        assert.equal(git(h.remote, "show", tag + ":result.txt"), title);
        ok(await h.cli("work", "close", "--work", started.workId));
      }
      assert.equal(git(h.repo, "ls-remote", "--tags", redirected), "");
      assert.equal(git(h.repo, "status", "--porcelain"), "");
      assert.equal(ok(await h.cli("db", "status")).integrity.valid, true);
      const interruptedTask = ok(await h.cli("task", "create", "--title", "interrupt fixture", "--criterion", "never deliver",
        "--environment", env.environmentId, "--repo-remote", h.remote, "--baseline", h.baseline));
      const interruptAgent = ok(await h.cli("work", "define-agent", "--name", "interrupt fixture", "--provider", "codex"));
      const interrupted = ok(await h.cli("work", "start", "--mode", "managed", "--task", interruptedTask.taskId, "--agent", interruptAgent.agentId, "--repo", h.repo));
      const spool = join(dataLayout().runtime, "executions", ledger, interrupted.executionId);
      const crashDeadline = Date.now() + 30_000;
      while (!existsSync(join(spool, "stdout.jsonl")) && Date.now() < crashDeadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const bridge = JSON.parse(readFileSync(join(spool, "bridge-owner"), "utf8"));
      assert.equal(signalHostProcessLeader(bridge.pid, bridge.birth, "SIGKILL"), true);
      let lost;
      do {
        lost = ok(await h.cli("work", "managed-status", "--run", interrupted.runId));
        if (lost.status === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < crashDeadline);
      assert.equal(lost.stage, "interrupted", JSON.stringify(lost));
      assert.equal(lost.stop, "verified");
      assert.equal(lost.trace, undefined);
      const hostRoot = join(dataLayout().runtime, "managed-host");
      for (const run of [interrupted, ...jobs.map(job => job.started)]) {
        await withRuntimeLock(hostRoot, "execution-" + run.executionId, async () => {}, 10_000);
      }
      await withRuntimeLock(hostRoot, "host", async () => {}, 10_000);
      const damaged = new DatabaseSync(join(h.directory, "ledger.db"));
      try {
        damaged.prepare("DELETE FROM work_evidence_chunks WHERE digest=?").run(archivedDigest);
        damaged.prepare("DELETE FROM work_evidence WHERE digest=?").run(archivedDigest);
      } finally { damaged.close(); }
      assert.equal(ok(await h.cli("db", "status")).integrity.valid, false);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      for(const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean))docker("rm","-f",id);
    }
  });
});

test("managed worker runs a refinement in its retained workspace with the original environment", {skip: !process.env.GROUNDS_TEST_MANAGED_AGENT}, async () => {
  await withHarness(async h => {
    const docker = (...args: string[]) => execFileSync("docker", args, {encoding: "utf8"}).trim();
    const image = process.env.GROUNDS_TEST_MANAGED_AGENT!;
    const digest = docker("image", "inspect", "--format", "{{.Id}}", image);
    const config = join(h.directory, "devcontainer.json");
    writeFileSync(config, JSON.stringify({image, overrideCommand: false, workspaceFolder: "/work",
      postCreateCommand: "test -f .setup-first || { touch .setup-first; exit 1; }; test -f .setup-second || { touch .setup-second; exit 1; }"}));
    const define = ["work", "define-environment", "--name", "retained", "--devcontainer", config, "--image-digest", digest];
    const environment = ok(await h.cli(...define));
    const task = ok(await h.cli("task", "create", "--title", "handoff fixture", "--criterion", "use notes", "--environment", environment.environmentId, "--repo-remote", h.remote, "--baseline", h.baseline));
    const agent = ok(await h.cli("work", "define-agent", "--name", "fixture", "--provider", "codex"));
    const managed = ["--mode", "managed", "--agent", agent.agentId, "--repo", h.repo];
    const ledger = ok(await h.cli("db", "status")).database_id;
    const awaitDelivery = async (runId: string, expected = "delivered") => {
      const deadline = Date.now() + 45_000;
      let status;
      do {
        status = ok(await h.cli("work", "managed-status", "--run", runId));
        if (status.status === "delivered" || status.host?.state === "blocked" || status.status === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      assert.equal(status.status, expected, JSON.stringify(status));
      await withRuntimeLock(join(dataLayout().runtime, "managed-host"), "execution-" + status.executionId, async () => {}, 10_000);
      return ok(await h.cli("work", "run", "--run", runId)).run;
    };
    try {
      const failed = ok(await h.cli("work", "start", "--task", task.taskId, ...managed));
      const unprepared = await awaitDelivery(failed.runId, "failed");
      const partial = docker("ps", "-aq", "--filter", "label=dev.grounds.sandbox=" + unprepared.sandboxId);
      assert.ok(partial);
      const retry = ok(await h.cli("work", "continue", "--work", failed.workId, "--expected-head", failed.runId, ...managed));
      const stillBlocked = await awaitDelivery(retry.runId, "failed");
      assert.equal(stillBlocked.sandboxId, unprepared.sandboxId);
      const first = ok(await h.cli("work", "continue", "--work", failed.workId, "--expected-head", retry.runId, ...managed));
      const parent = await awaitDelivery(first.runId);
      assert.equal(parent.sandboxId, unprepared.sandboxId);
      const replacement = docker("ps", "-aq", "--filter", "label=dev.grounds.sandbox=" + parent.sandboxId);
      assert.ok(replacement && replacement !== partial);
      writeFileSync(config, JSON.stringify({image, overrideCommand: false, workspaceFolder: "/new-workspace"}));
      const originalTag = "refs/tags/grounds/deliveries/" + parent.manifest.items[0].id;
      const repairSource = join(h.directory, "repair-source.git");
      execFileSync("git", ["clone", "--bare", "--quiet", h.remote, repairSource]);
      const fixedCommit = git(repairSource, "rev-parse", originalTag);
      git(h.remote, "update-ref", "-d", originalTag);
      ok(await h.cli("work", "repair", "--run", first.runId, "--delivery", parent.manifest.items[0].id, "--repo", repairSource));
      assert.throws(() => git(h.repo, "cat-file", "-e", fixedCommit));
      const newer = ok(await h.cli(...define, "--environment", environment.environmentId, "--expected-seq", "1"));
      const next = ["work", "continue", "--work", first.workId, "--expected-head", first.runId, ...managed];
      assert.equal((await h.cli(...next, "--environment-revision", newer.revisionId)).ok, false);
      const child = ok(await h.cli(...next));
      const run = await awaitDelivery(child.runId);
      const container = docker("ps", "-aq", "--filter", "label=dev.grounds.sandbox=" + parent.sandboxId);
      assert.equal(docker("inspect", "-f", "{{.State.Paused}}", container), "true", docker("inspect", "-f", "{{json .State}}", container));
      assert.equal(run.sandboxId, parent.sandboxId);
      assert.equal(run.environment.source, "inherited");
      assert.equal(run.environment.revision.revisionId, parent.environment.revision.revisionId);
      const tag = "refs/tags/grounds/deliveries/" + run.manifest.items[0].id;
      assert.equal(git(h.remote, "show", tag + ":result.txt"), "inherited uncommitted note");
      assert.equal(git(h.remote, "ls-tree", "--name-only", tag, "scratch-note"), "");
      assert.equal((await h.cli("work", "branch", "--work", first.workId, "--refines", first.runId, ...managed, "--sandbox", "inherit")).ok, false);
      // Crash after admission, before the receiver dispatches: cancellation
      // must settle the transfer while preserving the retained, paused runtime.
      const opened = await openStore(join(h.directory, "config.yaml"));
      let cancelledRun;
      try {
        const {composeWork} = await import("../src/work/composition.js");
        const app = composeWork(opened.store);
        const admitted = await app.exec.continueWork({requestId: newUUIDv7(), workId: first.workId, expectedHead: child.runId,
          workerMode: "managed", agent: {definitionId: agent.agentId, repositoryPath: h.repo}});
        assert.ok(admitted.ok);
        cancelledRun = admitted.value.runId;
      } finally { await opened.store.close(); }
      const cancelled = ok(await h.cli("work", "cancel", "--run", cancelledRun));
      assert.equal(cancelled.status, "cancelled");
      assert.equal(docker("inspect", "-f", "{{.State.Paused}}", container), "true", docker("inspect", "-f", "{{json .State}}", container));
      ok(await h.cli("work", "close", "--work", first.workId));
    } finally {
      for (const id of docker("ps", "-aq", "--filter", "label=dev.grounds.ledger=" + ledger).split("\n").filter(Boolean)) docker("rm", "-f", id);
    }
  });
});

test("test grading runs ordered commands in its own sandbox and releases the private checkout", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT}, async () => {
  await withHarness(async h => {
    const docker = (...args:string[]) => execFileSync("docker",args,{encoding:"utf8"}).trim();
    const image = process.env.GROUNDS_TEST_MANAGED_AGENT!;
    const digest = docker("image","inspect","--format","{{.Id}}",image);
    const config = join(h.directory,"grader-container.json"), commands = join(h.directory,"commands.json"), cases = join(h.directory,"cases.json");
    writeFileSync(config, JSON.stringify({image,workspaceFolder:"/work",overrideCommand:false,remoteEnv:{GRADER_FLAG:"from-devcontainer"}}));
    const env = ok(await h.cli("work","define-environment","--name","evaluation","--devcontainer",config,"--image-digest",digest));
    const task = ok(await h.cli("task","create","--title","produce answer","--criterion","correct","--repo-remote",h.remote,"--baseline",h.baseline));
    const deliver = async () => {
      const run = ok(await h.cli("work","start","--task",task.taskId,"--mode","none"));
      const {delivery} = ok(await h.cli("work","deliver","--run",run.runId,"--repo",h.repo,"--commit","HEAD"));
      return {runId:run.runId,deliveryId:delivery.id};
    };
    const target = await deliver();
    writeFileSync(join(h.repo,"check.sh"),'#!/bin/sh\ntest "$(cat app.txt)" = v0 && test ! -e check.sh && test "$GRADER_FLAG" = from-devcontainer && ! (echo rewrite >> /grounds-grader/check.sh)\n');
    git(h.repo,"add","check.sh");git(h.repo,"commit","-qm","private evaluator material");
    git(h.repo,"update-index","--chmod=+x","check.sh");git(h.repo,"commit","-qm","freeze executable bit");
    const curator = await deliver();
    writeFileSync(commands, JSON.stringify([["/grounds-grader/check.sh"],["sh","-c","head -c 1100000 /dev/zero; echo failure >&2; exit 7"]]));
    const grader = ok(await h.cli("grade","define-test","--name","private checks","--commands",commands,"--environment",env.environmentId,"--environment-revision",env.revisionId,"--pass","accept","--fail","reject"));
    writeFileSync(cases, JSON.stringify([{key:"example",...target,bindings:[{key:"tests",grader:{definitionId:grader.graderId,revisionId:grader.revisionId},
      hiddenTestPaths:["check.sh"],materialSource:curator}]}]));
    const suite = ok(await h.cli("suite","publish","--name","private suite","--cases-file",cases));
    const args = ["suite","measure","--suite",suite.suiteId,"--revision","1","--case","example","--run",target.runId,"--delivery",target.deliveryId,"--operation-id",newUUIDv7()];
    const ledger = ok(await h.cli("db","status")).database_id;
    try {
      const admitted = ok(await h.cli(...args));
      assert.deepEqual(ok(await h.cli(...args)),admitted);
      const deadline = Date.now() + 90_000;
      let status;
      do {
        status = ok(await h.cli("grade","test-status","--grading",admitted.gradingId));
        if (["terminal","blocked","awaiting-resume"].includes(status.host?.state)) break;
        await new Promise(resolve => setTimeout(resolve,250));
      } while (Date.now() < deadline);
      assert.equal(status.host?.state,"terminal",JSON.stringify(status));
      assert.equal(status.sandboxPhase,"released");
      const record = ok(await h.cli("grade","show","--grading",admitted.gradingId));
      assert.equal(record.commandSteps[1].output.stdout.complete,false);
      assert.equal(record.commandSteps[1].output.stdout.byteLength,1048576);
      assert.equal(record.commandSteps[1].output.stdout.observedBytes,1100000);
      const diagnostic = ok(await h.cli("grade","test-output","--grading",admitted.gradingId,"--step","1","--stream","stderr","--chunk","0"));
      assert.equal(Buffer.from(diagnostic.base64,"base64").toString(),"failure\n");
      assert.deepEqual(record.grade,{form:"category",category:"reject"});
      assert.deepEqual(record.commandSteps.map((step:{exitCode:number})=>step.exitCode),[0,7]);
      assert.equal(docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger),"");
      assert.equal(existsSync(join(dataLayout().workspaces,"sandboxes",ledger,record.sandboxId)),false);
      assert.equal(ok(await h.cli("work","run","--run",target.runId)).run.status,"delivered");
      writeFileSync(commands, JSON.stringify([["sh","-c","touch /tmp/grader-command-ready && exec sleep 180"]]));
      const slow = ok(await h.cli("grade","define-test","--name","interruptible check","--commands",commands,
        "--environment",env.environmentId,"--environment-revision",env.revisionId,"--pass","yes","--fail","no"));
      writeFileSync(cases, JSON.stringify([{key:"slow",...target,bindings:[{key:"tests",grader:{definitionId:slow.graderId,revisionId:slow.revisionId}}]}]));
      const interruptible = ok(await h.cli("suite","publish","--name","fault fixture","--cases-file",cases));
      for (const interrupt of ["cancel", "lose-collector"]) {
        const job = ok(await h.cli("suite","measure","--suite",interruptible.suiteId,"--revision","1","--case","slow","--run",target.runId,"--delivery",target.deliveryId));
        const until = Date.now() + 60_000;
        let row, ready = false;
        do {
          row = ok(await h.cli("grade","show","--grading",job.gradingId));
          if (row.sandboxId && row.commandSteps.length) {
            const instance = docker("ps","-q","--filter","label=dev.grounds.sandbox="+row.sandboxId);
            try { if (instance) { docker("exec",instance,"test","-f","/tmp/grader-command-ready"); ready=true; } }
            catch { /* Wait for the real process to start. */ }
          }
          if (!ready) await new Promise(resolve => setTimeout(resolve,250));
        } while (!ready && Date.now() < until);
        assert.ok(ready, "evaluator command reached its barrier");
        if (interrupt === "cancel") ok(await h.cli("grade","cancel","--grading",job.gradingId));
        else {
          const bridge = JSON.parse(readFileSync(join(dataLayout().workspaces,"sandboxes",ledger,row.sandboxId,"test-commands","0-1","bridge-owner"),"utf8"));
          assert.equal(signalHostProcessLeader(bridge.pid,bridge.birth,"SIGKILL"),true);
        }
        do {
          status = ok(await h.cli("grade","test-status","--grading",job.gradingId));
          if (status.host?.state === "terminal") break;
          await new Promise(resolve => setTimeout(resolve,250));
        } while (Date.now() < until);
        assert.equal(status.sandboxPhase,"released",JSON.stringify(status));
        assert.equal(status.status,interrupt === "cancel" ? "cancelled" : "grader_fault");
        row = ok(await h.cli("grade","show","--grading",job.gradingId));
        assert.equal(row.commandSteps[0].state,"stopped_no_result");
        assert.equal(row.grade,undefined);
        assert.equal(docker("ps","-aq","--filter","label=dev.grounds.sandbox="+row.sandboxId),"");
        await withRuntimeLock(join(dataLayout().runtime,"managed-host"),"execution-"+job.gradingId,async()=>{},10_000);
      }
      await withRuntimeLock(join(dataLayout().runtime,"managed-host"),"execution-"+admitted.gradingId,async()=>{},10_000);
    } finally {
      for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id);
    }
  });
});
