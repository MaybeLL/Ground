import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, existsSync, statSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("standalone runs refine a frozen delivery and never allocate a Work",async()=>{
  await withHarness(async h=>{
    const task=ok(await h.cli("task","create","--title","Independent run","--criterion","archive commit","--repo-remote",h.remote,"--baseline",h.baseline));
    const start=["work","start-run","--task",task.taskId,"--mode","none","--retention","release","--operation-id",newUUIDv7()];
    assert.equal((await h.cli(...start,"--refine","typo")).ok,false);
    const first=ok(await h.cli(...start));
    assertContract("work-results.schema.json",first);
    assert.deepEqual(ok(await h.cli(...start)),first);
    const run=ok(await h.cli("work","run","--run",first.runId)).run;
    assert.equal(run.workId,undefined);
    assert.equal(run.retention,"release");
    const refine=["work","start-run","--task",task.taskId,"--mode","external","--refines",run.id];
    assert.equal((await h.cli(...refine)).ok,false);
    const delivery=ok(await h.cli("work","deliver","--run",run.id));
    const second=ok(await h.cli(...refine));
    assertContract("work-results.schema.json",second);
    assert.equal(second.refines,run.id);
    const workspace=ok(await h.cli("work","workspace","--run",second.runId));
    assert.equal(workspace.base.commit,delivery.delivery.commit);
    assert.equal(workspace.base.from,"delivery");
    const cancelled=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","none"));
    ok(await h.cli("work","cancel","--run",cancelled.runId));
    const fresh=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","external","--refines",cancelled.runId,"--sandbox","fresh"));
    assert.equal(ok(await h.cli("work","workspace","--run",fresh.runId)).base.commit,h.baseline);
    const db=new DatabaseSync(join(h.directory,"ledger.db"));
    try {assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_works").get()?.n,0);} finally {db.close();}
  });
});

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
    git(h.remote,"update-ref","-d","refs/tags/grounds/deliveries/"+delivered.delivery.id);
    assert.equal((await h.cli("work","deliver","--run",started.runId,"--repo",space.path)).ok,false);
    assert.equal(git(h.remote,"tag","--list"),"");
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

test("external agents save and read explicit working artifacts before declaring delivery", async () => {
  await withHarness(async h=>{
    const task = ok(await h.cli("task","create","--kind","working","--title","Write report","--criterion","readable","--required-output","report"));
    const {runId} = ok(await h.cli("work","start","--mode","external","--task",task.taskId));
    const {sessionId} = ok(await h.cli("work","register","--run",runId,"--agent","writer"));
    const file = join(h.directory,"report");
    writeFileSync(file,Buffer.from([0,127,255]));
    const fifo = join(h.directory,"fifo");
    execFileSync("mkfifo",[fifo]);
    for (const source of ["/dev/zero",fifo]) {
      const result=await h.cli("work","save-artifact","--run",runId,"--session",sessionId,"--slot","report","--file","report="+source);
      assert.equal(result.error.code,"VALIDATION_ERROR");
    }
    const {artifact} = ok(await h.cli("work","save-artifact","--run",runId,"--session",sessionId,"--slot","report","--file","report.bin="+file));
    writeFileSync(file,"later edits");
    const chunk = ok(await h.cli("work","artifact-file","--run",runId,"--artifact",artifact.id,"--path","report.bin","--chunk","0"));
    assert.deepEqual(Buffer.from(chunk.base64,"base64"),Buffer.from([0,127,255]));
    assert.deepEqual(ok(await h.cli("work","artifact","--run",runId,"--artifact",artifact.id)).artifact,artifact);
    const result = ok(await h.cli("work","submit-artifacts","--run",runId,"--session",sessionId,"--artifact",artifact.id));
    assert.equal(result.submitted.status,"delivered");
    const rule=ok(await h.cli("grade","define-rule","--name","matches report","--rule","equal-file-bytes","--pass","yes","--fail","no"));
    const definition={definitionId:rule.graderId,revisionId:rule.revisionId};
    const cases=join(h.directory,"historical.json");
    writeFileSync(cases,JSON.stringify([{key:"report",runId,deliveryId:artifact.id,bindings:[{key:"content",answerPath:"report.bin",referencePath:"report.bin",grader:definition}]}]));
    const suite=ok(await h.cli("suite","publish","--name","report suite","--cases-file",cases));
    const snapshot=ok(await h.cli("suite","show","--suite",suite.suiteId,"--revision","1"));
    assert.equal(snapshot.cases[0].source.artifactSlot,"report");
    assert.equal(snapshot.cases[0].source.commit,null);
    assert.equal(snapshot.cases[0].bindings[0].materials[0].digest,chunk.ref.digest);
    const measured=ok(await h.cli("suite","measure","--suite",suite.suiteId,"--revision","1","--case","report","--run",runId,"--delivery",artifact.id));
    assert.equal(measured.result,"yes");
    assert.equal(measured.actualDigest,chunk.ref.digest);
    const db=new DatabaseSync(join(h.directory,"ledger.db"));
    try {db.prepare("DELETE FROM work_evidence_chunks WHERE digest=?").run(chunk.ref.digest);}
    finally {db.close();}
    assert.equal((await h.cli("suite","publish","--name","unavailable","--cases-file",cases)).error.code,"STORAGE_TRANSIENT");
  });
});

test("agent grader definitions bind a rubric, scale, evaluator and environment revision",async()=>{
  await withHarness(async h=>{
    const cfg=join(h.directory,"devcontainer.json"), scale=join(h.directory,"scale.json");
    writeFileSync(cfg,JSON.stringify({image:"debian:bookworm"}));
    writeFileSync(scale,JSON.stringify({form:"numeric",min:0,max:5}));
    const env=ok(await h.cli("work","define-environment","--name","evaluation","--devcontainer",cfg,"--image-digest","sha256:"+"a".repeat(64)));
    const agent=ok(await h.cli("work","define-agent","--provider","codex","--name","reviewer"));
    const args=["grade","define-agent","--name","quality","--agent",agent.agentId,"--agent-revision",agent.revisionId,"--environment",env.environmentId,
      "--environment-revision",env.revisionId,"--rubric","Rate factual accuracy from 0 to 5.","--scale",scale];
    const one=ok(await h.cli(...args));
    assert.equal(one.seq,1);
    writeFileSync(scale,JSON.stringify({form:"numeric",min:5,max:0}));
    assert.equal((await h.cli(...args,"--grader",one.graderId,"--expected-seq","1")).ok,false);
    writeFileSync(scale,JSON.stringify({form:"category",categories:["accurate","incomplete"]}));
    const two=ok(await h.cli(...args,"--grader",one.graderId,"--expected-seq","1"));
    assert.equal(two.seq,2);assert.notEqual(two.revisionId,one.revisionId);
  });
});

test("working materials reject an annotated tag object in place of its commit",async()=>{
  await withHarness(async h=>{
    git(h.repo,"tag","-a","annotated","-m","annotated");
    const material=join(h.directory,"input.json");
    writeFileSync(material,JSON.stringify([{name:"repo",repository:h.repo,commit:git(h.repo,"rev-parse","refs/tags/annotated")}]));
    const task=ok(await h.cli("task","create","--kind","working","--title","Inspect","--criterion","pinned","--materials",material));
    const {runId}=ok(await h.cli("work","start","--mode","none","--task",task.taskId));
    assert.equal((await h.cli("work","workspace","--run",runId)).ok,false);
  });
});

test("working workspace keeps pinned input separate from writable output on replay", async () => {
  await withHarness(async h=>{
    const file = join(h.directory,"materials.json");
    writeFileSync(join(h.repo,".gitattributes"),"*.txt text eol=crlf\n");
    symlinkSync("app.txt",join(h.repo,"internal-link"));
    git(h.repo,"add","-A"); git(h.repo,"commit","-qm","pin checkout attributes and link");
    writeFileSync(file,JSON.stringify([{name:"source",repository:h.repo,commit:git(h.repo,"rev-parse","HEAD")}]));
    const task = ok(await h.cli("task","create","--kind","working","--title","Inspect","--criterion","cite source","--materials",file));
    const savedTask = ok(await h.cli("task","show","--task",task.taskId));
    assert.deepEqual(savedTask.revision.content.outputs,[{key:"result",required:true}]);
    const {runId} = ok(await h.cli("work","start","--mode","none","--task",task.taskId));
    writeFileSync(join(h.repo,"app.txt"),"later");
    git(h.repo,"commit","-qam","advance");
    const workspace = ok(await h.cli("work","workspace","--run",runId)), material = workspace.materials[0].path;
    try {
      assert.equal(workspace.kind,"working");
      assert.equal(readFileSync(join(material,"internal-link"),"utf8"),"v0\n");
      assert.match((await h.cli("work","prepare-sandbox","--run",runId)).error.message,/no resolved environment/);
      assert.equal(readFileSync(join(material,"app.txt"),"utf8"),"v0\n");
      assert.equal(statSync(join(material,"app.txt")).mode & 0o222,0);
      assert.equal(statSync(material).mode & 0o222,0);
      assert.equal(existsSync(join(material,".git")),false);
      writeFileSync(join(workspace.path,"report"),"draft");
      const manifest = join(dirname(workspace.path),"sources.json");
      chmodSync(manifest,0o600);
      writeFileSync(manifest,JSON.stringify(JSON.parse(readFileSync(manifest,"utf8")).repositories));
      chmodSync(join(material,"app.txt"),0o600);
      writeFileSync(join(material,"app.txt"),"v0\r\n");
      chmodSync(join(material,"app.txt"),0o444);
      const again = ok(await h.cli("work","workspace","--run",runId));
      const upgraded=again.materials[0].path;
      assert.equal(readFileSync(join(upgraded,"app.txt"),"utf8"),"v0\n");
      assert.equal(again.created,false);
      assert.equal(readFileSync(join(again.path,"report"),"utf8"),"draft");
      assert.equal(readFileSync(join(h.repo,"app.txt"),"utf8"),"later");
      const moved=workspace.path+"-saved";
      renameSync(workspace.path,moved);
      symlinkSync(h.directory,workspace.path);
      assert.equal((await h.cli("work","workspace","--run",runId)).ok,false);
      rmSync(workspace.path); renameSync(moved,workspace.path);
      chmodSync(join(upgraded,"app.txt"),0o600);
      writeFileSync(join(upgraded,"app.txt"),"forged");
      chmodSync(join(upgraded,"app.txt"),0o444);
      assert.equal((await h.cli("work","workspace","--run",runId)).ok,false);
      assert.equal(readFileSync(join(workspace.path,"report"),"utf8"),"draft");
    } finally {
      const raw=join(dirname(workspace.path),"raw-materials");
      if (existsSync(raw)) {chmodSync(raw,0o700);chmodSync(join(raw,"source"),0o700);}
      chmodSync(dirname(material),0o700); chmodSync(material,0o700);
      rmSync(dirname(workspace.path),{recursive:true,force:true});
    }
  });
});

test("coding work submits its candidate and required attachment in a single manifest",async()=>{
  await withHarness(async h=>{
    const task=ok(await h.cli("task","create","--title","Code and report","--criterion","tested","--required-output","report","--repo-remote",h.remote,"--baseline",h.baseline));
    const {runId}=ok(await h.cli("work","start","--task",task.taskId,"--mode","none"));
    const {artifact}=ok(await h.cli("work","save-artifact","--run",runId,"--slot","report","--file","summary=app.txt"));
    assert.equal((await h.cli("work","submit-artifacts","--run",runId,"--artifact",artifact.id)).ok,false);
    assert.equal((await h.cli("work","deliver","--run",runId)).ok,false);
    assert.equal(git(h.remote,"tag","--list"),"");
    const submitted=ok(await h.cli("work","deliver","--run",runId,"--artifact",artifact.id));
    assert.equal(submitted.submitted.status,"delivered");
    const view=ok(await h.cli("work","run","--run",runId));
    assert.deepEqual(view.run.manifest.items.map((item:{type:string})=>item.type),["candidate","artifact"]);
  });
});

test("late delivery recognizes the same attachment set in a different order",async()=>{
  await withHarness(async h=>{
    const task=ok(await h.cli("task","create","--title","Archive","--criterion","includes both reports","--required-output","a","--required-output","b","--repo-remote",h.remote,"--baseline",h.baseline));
    const {runId}=ok(await h.cli("work","start","--mode","none","--task",task.taskId));
    const save=async(slot:string)=>ok(await h.cli("work","save-artifact","--run",runId,"--slot",slot,"--file","note=app.txt")).artifact.id;
    const a=await save("a"), b=await save("b");
    const deliver=(first:string,second:string)=>h.cli("work","deliver","--run",runId,"--artifact",first,"--artifact",second);
    assert.equal(ok(await deliver(a,b)).submitted.outcome,"applied");
    assert.equal(ok(await deliver(b,a)).submitted.outcome,"late");
    assert.equal(git(h.remote,"tag","--list").split("\n").length,1);
  });
});

test("task revisions preserve the chosen workspace kind", async () => {
  await withHarness(async h => {
    const task = ok(await h.cli("task","create","--kind","working","--required-output","report","--optional-output","chart","--title","Summarize changes","--criterion","include evidence"));
    ok(await h.cli("task","revise","--task",task.taskId,"--expected-seq","1","--title","Summarize changes","--criterion","cite revisions"));
    for (const revision of ["1","2"]) {
      const view = ok(await h.cli("task","show","--task",task.taskId,"--revision",revision));
      assert.equal(view.revision.content.kind,"working");
      assert.deepEqual(view.revision.content.outputs,[{key:"report",required:true},{key:"chart",required:false}]);
    }
    assert.equal((await h.cli("task","create","--kind","unknown","--title","x","--criterion","x")).ok,false);
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

test("an interrupted candidate publication owns its operation across runs and reconciles without another push",async t=>{
  await withHarness(async h=>{
    const {TaskExecution}=await import("../src/work/application/task-execution.js");
    const task=ok(await h.cli("task","create","--title","Exclusive publication","--criterion","archived","--repo-remote",h.remote,"--baseline",h.baseline));
    const start=async()=>ok(await h.cli("work","start","--mode","none","--task",task.taskId)).runId as string;
    const first=await start(), second=await start(), requestId=newUUIDv7();
    const deliver=(run:string)=>h.cli("work","deliver","--run",run,"--operation-id",requestId);
    t.mock.method(TaskExecution.prototype,"submit",async()=>{throw new Error("ledger interrupted after push");},{times:1});
    assert.equal((await deliver(first)).ok,false);
    const tags=git(h.remote,"show-ref","--tags");
    assert.ok(tags.includes(first));
    const collision=await h.cli("task","create","--title","Competing command","--criterion","exclusive","--operation-id",requestId);
    assert.equal(collision.error.code,"IDEMPOTENCY_CONFLICT");
    assert.equal((await deliver(second)).ok,false);
    assert.equal(git(h.remote,"show-ref","--tags"),tags);
    assert.equal(ok(await h.cli("work","reconcile","--run",first)).submission.status,"delivered");
    assert.equal(git(h.remote,"show-ref","--tags"),tags);
  });
});

test("cancellation settles an interrupted publication and its original operation can replay",async t=>{
  await withHarness(async h=>{
    const {TaskExecution}=await import("../src/work/application/task-execution.js");
    const task=ok(await h.cli("task","create","--title","Interrupted candidate","--criterion","archive","--repo-remote",h.remote,"--baseline",h.baseline));
    const {runId}=ok(await h.cli("work","start","--mode","external","--task",task.taskId));
    const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","writer"));
    const delivery=["work","deliver","--run",runId,"--session",sessionId,"--operation-id",newUUIDv7()];
    t.mock.method(TaskExecution.prototype,"submit",async()=>{throw new Error("interrupted after push");},{times:1});
    assert.equal((await h.cli(...delivery)).ok,false);
    const tags=git(h.remote,"show-ref","--tags");
    ok(await h.cli("work","cancel","--run",runId));
    ok(await h.cli("work","stop","--run",runId,"--reason","human"));
    const recovered=ok(await h.cli("work","reconcile","--run",runId)).submission;
    assert.equal(recovered.outcome,"cancel-wins");
    assert.deepEqual(ok(await h.cli(...delivery)).submitted,recovered);
    renameSync(h.remote,h.remote+"-offline");
    try {assert.deepEqual(ok(await h.cli(...delivery)).submitted,recovered);} finally {renameSync(h.remote+"-offline",h.remote);}
    assert.equal(git(h.remote,"show-ref","--tags"),tags);
  });
});

test("after a confirmed push a lost attachment rejects the frozen submission and settlement can retry",async t=>{
  await withHarness(async h=>{
    const {TaskExecution}=await import("../src/work/application/task-execution.js");
    const {SandboxLifecycle}=await import("../src/work/application/sandbox-lifecycle.js");
    const task=ok(await h.cli("task","create","--title","Frozen attachment","--criterion","report","--required-output","report","--repo-remote",h.remote,"--baseline",h.baseline));
    const {runId}=ok(await h.cli("work","start","--mode","external","--task",task.taskId));
    const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","writer"));
    const {artifact}=ok(await h.cli("work","save-artifact","--run",runId,"--session",sessionId,"--slot","report","--file","report=app.txt"));
    t.mock.method(TaskExecution.prototype,"submit",async()=>{throw new Error("interruption after push");},{times:1});
    assert.equal((await h.cli("work","deliver","--run",runId,"--session",sessionId,"--artifact",artifact.id)).ok,false);
    const db=new DatabaseSync(join(h.directory,"ledger.db"));
    try {assert.equal(db.prepare("DELETE FROM work_intents WHERE request_id=?").run(artifact.id).changes,1);} finally {db.close();}
    const original=SandboxLifecycle.prototype.settleRun;
    const settle=t.mock.method(SandboxLifecycle.prototype,"settleRun",original);
    settle.mock.mockImplementationOnce(async()=>{throw new Error("interrupted settlement");});
    assert.equal((await h.cli("work","reconcile","--run",runId)).ok,false);
    const final=ok(await h.cli("work","run","--run",runId)).run;
    assert.equal(final.status,"failed");
    assert.equal(final.failure.class,"agent-output");
    assert.equal(final.worker.registration.stop.reason,"submitted");
    ok(await h.cli("work","reconcile","--run",runId));
    assert.equal(settle.mock.callCount(),2);
  });
});

test("a human stop allows the registered external session to publish its finished commit",async()=>{
  await withHarness(async h=>{
    const task=ok(await h.cli("task","create","--title","Stopped writer","--criterion","archive commit","--repo-remote",h.remote,"--baseline",h.baseline));
    const {runId}=ok(await h.cli("work","start","--mode","external","--task",task.taskId));
    const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","writer"));
    ok(await h.cli("work","stop","--run",runId,"--reason","human"));
    assert.equal(ok(await h.cli("work","deliver","--run",runId,"--session",sessionId)).submitted.status,"delivered");
  });
});

test("work reconcile finishes a stopped external submission after its receipt becomes reachable",async t=>{
  await withHarness(async h=>{
    const {GitTagArchive}=await import("../src/work/adapters/git/tag-archive.js");
    const check=GitTagArchive.prototype.check;
    const offline=h.remote+"-offline";
    const task=ok(await h.cli("task","create","--title","Frozen proposal","--criterion","archived","--repo-remote",h.remote,"--baseline",h.baseline));
    const {runId}=ok(await h.cli("work","start","--mode","external","--task",task.taskId));
    const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","writer"));
    const requestId=newUUIDv7();
    t.mock.method(GitTagArchive.prototype,"check",async function(this:InstanceType<typeof GitTagArchive>,...args:Parameters<typeof check>){
      renameSync(h.remote,offline);
      try {return await check.apply(this,args);} finally {renameSync(offline,h.remote);}
    },{times:1});
    const submitted=ok(await h.cli("work","deliver","--run",runId,"--session",sessionId,"--operation-id",requestId));
    assert.equal(submitted.submitted.blocked,"receipt-unavailable");
    const held=ok(await h.cli("work","run","--run",runId)).run;
    assert.equal(held.worker.registration.stop.reason,"submitted");
    assert.equal(held.pendingManifest.operationId,requestId);
    writeFileSync(join(h.repo,"private.txt"),"never publish replacement");
    git(h.repo,"add","private.txt");git(h.repo,"commit","-qm","different submission");
    const before=git(h.remote,"show-ref","--tags");
    assert.equal((await h.cli("work","deliver","--run",runId,"--session",sessionId,"--operation-id",newUUIDv7())).ok,false);
    assert.equal(git(h.remote,"show-ref","--tags"),before);
    const reconciled=ok(await h.cli("work","reconcile","--run",runId));
    assert.equal(reconciled.submission.status,"delivered");
    const final=ok(await h.cli("work","run","--run",runId)).run;
    assert.equal(final.manifest.operationId,requestId);
    assert.deepEqual(final.manifest.items.map((item:{id:string})=>item.id),[submitted.delivery.id]);
    assert.equal(ok(await h.cli("work","reconcile","--run",runId)).submission,undefined);
  });
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

test("a gate binds immutable transcript bytes from its own session and excludes reference-only declarations",async()=>{
  await withHarness(async h=>{
    const task=ok(await h.cli("task","create","--title","Trace","--criterion","auditable","--repo-remote",h.remote,"--baseline",h.baseline));
    const session=async()=>{
      const {runId}=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","external"));
      const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","writer"));
      ok(await h.cli("work","deliver","--run",runId,"--session",sessionId));
      return {runId,sessionId};
    };
    const external=await session(), other=await session();
    const bytes=Buffer.from("evidence\n".repeat(9100)), path=join(h.directory,"trace.log");
    const digest="sha256:"+createHash("sha256").update(bytes).digest("hex");
    const args=(target:typeof external)=>["work","transcript","--run",target.runId,"--session",target.sessionId,"--digest",digest,"--coverage","partial"];
    const gate=async(runId:string)=>ok(await h.cli("grade","request","--run",runId)).gradingId;
    const materials=async(id:string)=>ok(await h.cli("grade","show","--grading",id)).materials;
    for (const target of [external,other]) ok(await h.cli(...args(target),"--ref","sql-evidence:"+digest));
    const firstGate=await gate(external.runId);
    assert.deepEqual(await materials(firstGate),[]);
    writeFileSync(path,"wrong");
    const upload=[...args(external),"--file",path,"--operation-id",newUUIDv7()];
    assert.equal((await h.cli(...upload)).ok,false);
    writeFileSync(path,bytes);
    const result=ok(await h.cli(...upload));
    rmSync(path);
    assert.deepEqual(ok(await h.cli(...upload)),result);
    ok(await h.cli(...args(external),"--ref","evidence://second-report"));
    const view=ok(await h.cli("work","run","--run",external.runId));
    assertContract("work-results.schema.json",view);
    assert.equal(view.run.worker.registration.transcripts.at(-1).ref,"evidence://second-report");
    const read=(run:string,n:number)=>h.cli("work","trace","--run",run,"--digest",digest,"--stream","raw","--chunk",String(n));
    assert.deepEqual(Buffer.concat([Buffer.from(ok(await read(external.runId,0)).base64,"base64"),Buffer.from(ok(await read(external.runId,1)).base64,"base64")]),bytes);
    assert.equal((await read(other.runId,0)).ok,false);
    assert.deepEqual(await materials(await gate(other.runId)),[]);
    assert.equal((await h.cli("grade","request","--run",other.runId,"--material","transcript:"+digest+"="+digest)).ok,false);
    const frozen=await gate(external.runId);
    const binding=ok(await h.cli("grade","show","--grading",frozen)).binding;
    const {archivedEvidenceDigest,...legacyBinding}=binding;
    assert.match(archivedEvidenceDigest,/^sha256:/);
    const {sameBinding}=await import("../src/work/domain/index.js");
    assert.equal(sameBinding(binding,legacyBinding),false);
    assert.deepEqual(await materials(frozen),[{id:"transcript:"+digest,digest}]);
    assert.deepEqual(await materials(firstGate),[]);
    const db=new DatabaseSync(join(h.directory,"ledger.db"));
    try {db.prepare("DELETE FROM work_evidence_chunks WHERE digest=?").run(digest);db.prepare("DELETE FROM work_evidence WHERE digest=?").run(digest);} finally {db.close();}
    assert.equal((await h.cli("grade","request","--run",external.runId)).error.code,"STORAGE_TRANSIENT");
    assert.deepEqual(await materials(frozen),[{id:"transcript:"+digest,digest}]);
    assert.equal(ok(await h.cli("db","status")).integrity.valid,false);
  });
});

test("managed worker runs working tasks with a read-only material mount and an artifact-only manifest", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!, cfg=join(h.directory,"config.json"),materials=join(h.directory,"materials.json");
    writeFileSync(cfg,JSON.stringify({image,workspaceFolder:"/work"}));
    writeFileSync(materials,JSON.stringify([{name:"input",repository:h.repo,commit:h.baseline}]));
    const environment=ok(await h.cli("work","define-environment","--name","working","--devcontainer",cfg,"--image-digest",docker("image","inspect","--format","{{.Id}}",image)));
    const agent=ok(await h.cli("work","define-agent","--provider","codex","--name","working agent"));
    for (const title of ["read pinned input","invalid output path"]) {
      const task=ok(await h.cli("task","create","--kind","working","--title",title,"--criterion","cite the input","--materials",materials,"--required-output","report","--environment",environment.environmentId));
      const started=ok(await h.cli("work","start","--mode","managed","--task",task.taskId,"--agent",agent.agentId));
      try {
        const end=Date.now()+75000;
        let result;
        do {
          result=ok(await h.cli("work","managed-status","--run",started.runId));
          if (["delivered","failed","cancelled"].includes(result.status) || result.host?.state==="blocked") break;
          await new Promise(resolve=>setTimeout(resolve,200));
        } while (Date.now()<end);
        assert.equal(result.status,title==="invalid output path" ? "failed" : "delivered",JSON.stringify(result));
        const {run}=ok(await h.cli("work","run","--run",started.runId));
        if (title==="invalid output path") {assert.equal(run.manifest,undefined);continue;}
        assert.deepEqual(run.manifest.items.map((i:{type:string})=>i.type),["artifact"]);
        const id=run.manifest.items[0].id;
        assert.equal(ok(await h.cli("work","artifact","--artifact",id,"--run",started.runId)).artifact.executionId,started.executionId);
        const chunk=ok(await h.cli("work","artifact-file","--artifact",id,"--run",started.runId,"--path","report.txt","--chunk","0"));
        assert.equal(Buffer.from(chunk.base64,"base64").toString(),"v0\n");
        assert.equal(result.stage,"failed","a valid frozen delivery retains the provider failure");
        writeFileSync(materials,"[]");
        ok(await h.cli("task","revise","--task",task.taskId,"--expected-seq","1","--title",title,"--criterion","revised","--materials",materials,"--environment",environment.environmentId));
        const inherited=await h.cli("work","continue","--mode","managed","--work",started.workId,"--expected-head",started.runId,"--agent",agent.agentId,"--sandbox","inherit");
        assert.equal(inherited.ok,false);
        assert.match(inherited.error.message,/material binding/);
        writeFileSync(materials,JSON.stringify([{name:"input",repository:h.repo,commit:h.baseline}]));
      } finally {
        const run=ok(await h.cli("work","run","--run",started.runId)).run;
        if (run.sandboxId) for (const id of docker("ps","-aq","--filter","label=dev.grounds.sandbox="+run.sandboxId).split("\n").filter(Boolean)) docker("rm","-f",id);
      }
    }
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
        const task = ok(await h.cli("task", "create", "--title", title, "--criterion", "commit result", ...(jobs.length === 1 ? ["--required-output","report"] : []), "--environment", env.environmentId, "--repo-remote", "origin", "--baseline", h.baseline));
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
        assert.equal(view.stage,title==="concurrent fixture 1" ? "failed" : "succeeded");
        assert.equal(view.stop, "verified");
        const {run} = ok(await h.cli("work", "run", "--run", started.runId));
        assert.equal(run.manifest.origin, "contract");
        assert.equal(run.worker.executionId, started.executionId);
        if (title==="concurrent fixture 1") {
          const file=run.manifest.items.find((item:{type:string})=>item.type==="artifact");
          assert.ok(file);
          const saved=ok(await h.cli("work","artifact","--run",started.runId,"--artifact",file.id)).artifact;
          assert.equal(saved.executionId,started.executionId);
          const chunk=ok(await h.cli("work","artifact-file","--run",started.runId,"--artifact",file.id,"--path","report.txt","--chunk","0"));
          assert.equal(Buffer.from(chunk.base64,"base64").toString(),"uncommitted report\n");
        }
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

test("Feature install order ignores unreachable lock entries and preserves reachable dependencies",async()=>{
  const {featureOrder}=await import("../src/work/adapters/devcontainer/build.js");
  await withHarness(async h=>{
    const base=join(h.repo,".devcontainer"),local=join(base,"local");
    mkdirSync(local,{recursive:true});
    const old="registry.invalid/team/old", pinned="registry.invalid/team/pinned", parent="registry.invalid/team/parent:1";
    writeFileSync(join(local,"devcontainer-feature.json"),JSON.stringify({name:"local",installsAfter:[old,pinned]}));
    const entry={integrity:"sha256:"+"a".repeat(64)};
    const result=await featureOrder(h.repo,base,h.repo,["./local",parent],{[old+":1"]:entry,[pinned+":1"]:entry,[parent]:{...entry,dependsOn:[pinned+":1"]}},[old,"./local",pinned]);
    assert.deepEqual(result.order,["./local",pinned+":1"]);
    assert.deepEqual(JSON.parse(result.overlays[0]!.body).installsAfter,[pinned+":1"]);
  });
});

test("repository environment builds reject escaping paths, unpinned nested Features and host environment interpolation",async()=>{
  await withHarness(async h=>{
    const folder=join(h.repo,".devcontainer");
    mkdirSync(join(folder,"local"),{recursive:true});
    writeFileSync(join(folder,"Dockerfile"),"FROM scratch");
    writeFileSync(join(folder,"local","devcontainer-feature.json"),JSON.stringify({id:"local",version:"1.0.0",name:"local",dependsOn:{"ghcr.io/example/features/unpinned:1":{}}}));
    for (const [config,why] of [
      [{build:{dockerfile:"../../../etc/passwd"}},/escapes/],
      [{build:{dockerfile:"Dockerfile"},features:{"./local":{}}},/frozen lock entry/],
      [{build:{dockerfile:"Dockerfile"},containerEnv:{CANARY:"${localEnv:GROUNDS_CANARY}"}},/host environment/],
    ] as const) {
      writeFileSync(join(folder,"devcontainer.json"),JSON.stringify(config));
      git(h.repo,"add",".");git(h.repo,"commit","-qm","unsafe configuration");
      const result=await h.cli("work","build-environment","--name","invalid","--repo",h.repo,"--commit",git(h.repo,"rev-parse","HEAD"));
      assert.equal(result.error.code,"VALIDATION_ERROR");
      assert.match(result.error.message,why);
    }
  });
});

test("external sandbox runs a working task against read-only materials and returns its output to the host", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!,cfg=join(h.directory,"env.json"),sources=join(h.directory,"sources.json");
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
    writeFileSync(cfg,JSON.stringify({image,workspaceFolder:"/work",overrideCommand:false}));
    const input=join(h.directory,"material-clone");
    git(h.directory,"clone","-q",h.repo,input);
    writeFileSync(sources,JSON.stringify([{name:"input",repository:input,commit:h.baseline}]));
    const env=ok(await h.cli("work","define-environment","--name","materials","--devcontainer",cfg,"--image-digest",docker("image","inspect","--format","{{.Id}}",image)));
    const task=ok(await h.cli("task","create","--title","external report","--kind","working","--criterion","matches input","--materials",sources,"--environment",env.environmentId));
    const {runId}=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","external","--retention","release"));
    const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","external"));
    const workspace=ok(await h.cli("work","workspace","--run",runId));
    renameSync(input,input+"-offline");
    const ledger=ok(await h.cli("db","status")).database_id;
    try {
      ok(await h.cli("work","prepare-sandbox","--run",runId));
      const access=ok(await h.cli("work","sandbox-context","--run",runId,"--session",sessionId));
      assert.equal(access.workspace,workspace.path);
      const [tool,...argv]=access.argvPrefix;
      execFileSync(tool,[...argv,"sh","-ec","test ! -e .git && cp /grounds-materials/input/app.txt report.txt && ! touch /grounds-materials/input/new"],{stdio:"pipe"});
      const {artifact}=ok(await h.cli("work","save-artifact","--run",runId,"--session",sessionId,"--slot","result","--file","report.txt="+join(workspace.path,"report.txt")));
      assert.equal(ok(await h.cli("work","submit-artifacts","--run",runId,"--session",sessionId,"--artifact",artifact.id)).submitted.status,"delivered");
      assert.equal(readFileSync(join(workspace.path,"report.txt"),"utf8"),"v0\n");
    } finally {for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id);}
  });
});

test("external sandbox runs commands in the registered task workspace", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async t=>{
  await withHarness(async h=>{
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!,config=join(h.directory,"devcontainer.json");
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
    writeFileSync(config,JSON.stringify({image,workspaceFolder:"/task",overrideCommand:false}));
    const environment=ok(await h.cli("work","define-environment","--name","external commands","--devcontainer",config,"--image-digest",docker("image","inspect","--format","{{.Id}}",image)));
    const task=ok(await h.cli("task","create","--title","external runtime","--criterion","runtime output","--repo-remote",h.remote,"--baseline","main","--environment",environment.environmentId));
    const {runId}=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","external","--retention","release"));
    const {sessionId}=ok(await h.cli("work","register","--run",runId,"--agent","host-agent"));
    const ledger=ok(await h.cli("db","status")).database_id;
    try {
      const [prepared,context]=["prepare-sandbox","sandbox-context"].map(action=>["work",action,"--run",runId]);
      const {DevcontainerRuntime}=await import("../src/work/adapters/devcontainer/runtime.js");
      t.mock.method(DevcontainerRuntime.prototype,"exclusive",async()=>{throw Error("interrupted after reserving the sandbox");},{times:1});
      const original=[...prepared,"--repo",h.repo,"--operation-id",newUUIDv7()];
      assert.equal((await h.cli(...original)).ok,false);
      writeFileSync(join(h.repo,"late.txt"),"after reservation");
      git(h.repo,"add","late.txt");git(h.repo,"commit","-qm","advance branch after reservation");
      const sandbox=ok(await h.cli(...original));
      assert.equal(sandbox.commit,h.baseline);
      const {path}=ok(await h.cli("work","workspace","--run",runId,"--repo",h.repo));
      assert.equal(git(path,"rev-parse","HEAD"),h.baseline);
      const second=join(h.directory,"other-clone");
      git(h.directory,"clone","-q",h.repo,second);
      assert.equal((await h.cli("work","workspace","--run",runId,"--repo",second)).error.code,"STATE_CONFLICT");
      writeFileSync(join(path,"host-note.txt"),"from the external agent");
      assert.equal((await h.cli(...context,"--session",newUUIDv7())).error.code,"AUTH_FAILED");
      const access=ok(await h.cli(...context,"--session",sessionId));
      assertContract("sandbox-results.schema.json",access);
      assert.equal(access.workspace,path);
      assert.equal(access.instanceId,sandbox.instanceId);
      const [tool,...argv]=access.argvPrefix;
      execFileSync(tool,[...argv,"sh","-ec",'test "$(cat host-note.txt)" = "from the external agent" && cp host-note.txt result.txt'],{stdio:"pipe"});
      assert.equal(readFileSync(join(path,"result.txt"),"utf8"),"from the external agent");
      git(path,"add","result.txt");git(path,"commit","-qm","capture runtime result");
      const submitted=ok(await h.cli("work","deliver","--repo",path,"--run",runId,"--session",sessionId));
      assert.equal(submitted.submitted.status,"delivered");
      assert.equal(git(h.remote,"show","refs/tags/grounds/deliveries/"+submitted.delivery.id+":result.txt"),"from the external agent");
      assert.equal((await h.cli(...context,"--session",sessionId)).ok,false);
      assert.equal(docker("ps","-aq","--filter","label=dev.grounds.sandbox="+sandbox.sandboxId),"");
      assert.equal(readFileSync(join(path,"result.txt"),"utf8"),"from the external agent");
    } finally {for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id);}
  });
});

test("managed worker runs with an environment built from an immutable repository snapshot", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!;
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
    const folder=join(h.repo,".devcontainer");
    mkdirSync(folder);
    mkdirSync(join(folder,"marker-feature"));
    writeFileSync(join(folder,"marker-feature","devcontainer-feature.json"),JSON.stringify({id:"marker-feature",version:"1.0.0",name:"Frozen marker",installsAfter:["registry.invalid/unselected/missing:1"]}));
    writeFileSync(join(folder,"marker-feature","install.sh"),"#!/bin/sh\nprintf 'frozen feature' > /feature-marker\n",{mode:0o755});
    mkdirSync(join(folder,"after-feature"));
    writeFileSync(join(folder,"after-feature","devcontainer-feature.json"),JSON.stringify({id:"after-feature",version:"1.0.0",name:"Ordered marker"}));
    writeFileSync(join(folder,"after-feature","install.sh"),"#!/bin/sh\ntest -f /feature-marker || exit 1\nprintf 'features ordered' > /ordered-marker\n",{mode:0o755});
    const source=JSON.stringify({build:{dockerfile:"Dockerfile"},features:{"./after-feature":{},"./marker-feature":{}},overrideFeatureInstallOrder:["./marker-feature","./after-feature"],workspaceFolder:"/task",overrideCommand:false});
    writeFileSync(join(folder,"devcontainer.json"),source);
    writeFileSync(join(folder,"Dockerfile"),"FROM "+image+"\nCOPY --chown=1000:1000 marker.txt /environment-marker\nUSER 1000\nRUN test -w /environment-marker\nUSER root\n");
    writeFileSync(join(folder,"marker.txt"),"frozen bytes");
    git(h.repo,"add",".");git(h.repo,"commit","-qm","define environment");
    const commit=git(h.repo,"rev-parse","HEAD"), requestId=newUUIDv7();
    writeFileSync(join(folder,"marker.txt"),"dirty working tree");
    writeFileSync(join(folder,"devcontainer.json"),"invalid working tree configuration");
    const args=["work","build-environment","--repo",h.repo,"--commit",commit,"--name","frozen build","--operation-id",requestId];
    const db=new DatabaseSync(join(h.directory,"ledger.db"));
    let firstImage="";
    try {
      db.exec("CREATE TRIGGER interrupt_built_revision BEFORE INSERT ON work_revisions BEGIN SELECT RAISE(ABORT,'interrupted publication'); END");
      assert.equal((await h.cli(...args)).ok,false);
      const reservation=db.prepare("SELECT body_json FROM work_intents WHERE request_id=?").get(requestId);
      const buildId=JSON.parse(String(reservation?.body_json)).result.buildId;
      const ledger=ok(await h.cli("db","status")).database_id;
      const tag="grounds-environment:"+ledger+"-"+buildId;
      firstImage=docker("image","inspect","--format","{{.Id}}",tag);
      // Keep the frozen image addressable, then replace its mutable tag.
      docker("tag",firstImage,tag+"-original");
      docker("tag",image,tag);
      db.exec("DROP TRIGGER interrupt_built_revision");
    } finally {db.close();}
    const published=ok(await h.cli(...args));
    assertContract("sandbox-results.schema.json",published);
    const definition=ok(await h.cli("work","environment","--environment",published.environmentId,"--revision","1"));
    assertContract("sandbox-results.schema.json",definition);
    const built=JSON.parse(definition.content.config).image;
    const ledger=ok(await h.cli("db","status")).database_id;
    try {
      assert.equal(definition.content.build.source,source);
      assert.equal(definition.content.build.commit,commit);
      assert.equal(definition.content.imageDigest,firstImage);
      assert.notEqual(firstImage,docker("image","inspect","--format","{{.Id}}",built));
      assert.deepEqual(ok(await h.cli(...args)),published);
      assert.equal((await h.cli(...args,"--name","different")).ok,false);
      const task=ok(await h.cli("task","create","--title","built image","--criterion","uses frozen input","--repo-remote",h.remote,"--baseline",commit,"--environment",published.environmentId));
      const {runId}=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","external"));
      const sb=ok(await h.cli("work","prepare-sandbox","--run",runId,"--repo",h.repo));
      assert.equal(docker("exec",sb.instanceId,"cat","/environment-marker"),"frozen bytes");
      assert.equal(docker("exec",sb.instanceId,"cat","/feature-marker"),"frozen feature");
      assert.equal(docker("exec",sb.instanceId,"cat","/ordered-marker"),"features ordered");
      ok(await h.cli("work","cancel","--run",runId));
      ok(await h.cli("work","release-sandbox","--run",runId));
    } finally {
      for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id);
      docker("image","rm",built,built+"-original");
    }
  });
});

test("managed worker runs a standalone refinement in its inherited sandbox and releases it", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT}, async t=>{
  await withHarness(async h=>{
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!;
    const config=join(h.directory,"devcontainer.json");
    writeFileSync(config,JSON.stringify({image,overrideCommand:false,workspaceFolder:"/work"}));
    const environment=ok(await h.cli("work","define-environment","--name","standalone","--devcontainer",config,"--image-digest",docker("image","inspect","--format","{{.Id}}",image)));
    const agent=ok(await h.cli("work","define-agent","--name","standalone","--provider","codex"));
    const task=ok(await h.cli("task","create","--title","handoff fixture","--criterion","use notes","--environment",environment.environmentId,"--repo-remote",h.remote,"--baseline","main"));
    const start=["work","start-run","--task",task.taskId,"--mode","managed","--agent",agent.agentId,"--repo",h.repo];
    const finished=async(runId:string,expectedPhase:string)=>{
      const db=new DatabaseSync(join(h.directory,"ledger.db"),{readOnly:true});
      try {
        const phase=db.prepare("SELECT phase FROM work_sandboxes WHERE owner_id=?");
        const deadline=Date.now()+90000;
        let view,actualPhase;
        do {
          view=ok(await h.cli("work","managed-status","--run",runId));
          actualPhase=phase.get(runId)?.phase;
          if (view.status==="delivered" && actualPhase===expectedPhase) break;
          if (["failed","cancelled"].includes(view.status) || view.host?.state==="blocked") break;
          await new Promise(resolve=>setTimeout(resolve,200));
        } while (Date.now()<deadline);
        assert.equal(view.status,"delivered",JSON.stringify(view));
        assert.equal(actualPhase,expectedPhase,JSON.stringify(view));
        return ok(await h.cli("work","run","--run",runId)).run;
      } finally { db.close(); }
    };
    const ledger=ok(await h.cli("db","status")).database_id;
    try {
      const cancelled=ok(await h.cli("work","start-run","--task",task.taskId,"--mode","none"));
      ok(await h.cli("work","cancel","--run",cancelled.runId));
      const {TaskExecution}=await import("../src/work/application/task-execution.js");
      const admit=TaskExecution.prototype.startRun;
      t.mock.method(TaskExecution.prototype,"startRun",async function(this:InstanceType<typeof TaskExecution>,...args:Parameters<typeof admit>){
        const result=await admit.apply(this,args);
        writeFileSync(join(h.repo,"late.txt"),"after admission");
        git(h.repo,"add","late.txt"); git(h.repo,"commit","-qm","advance mutable baseline");
        return result;
      },{times:1});
      const first=ok(await h.cli(...start,"--refines",cancelled.runId,"--sandbox","fresh","--retention","keep","--environment-revision",environment.revisionId));
      const parent=await finished(first.runId,"paused");
      const parentTag="refs/tags/grounds/deliveries/"+parent.manifest.items[0].id;
      assert.equal(git(h.remote,"rev-parse",parentTag+"^"),h.baseline);
      assert.equal(parent.workId,undefined);
      assert.equal(parent.environment.source,"specified");
      const child=ok(await h.cli(...start,"--refines",first.runId,"--retention","release","--sandbox","inherit"));
      const run=await finished(child.runId,"released");
      assert.equal(run.workId,undefined);
      assert.equal(run.sandboxId,parent.sandboxId);
      assert.equal(run.environment.source,"inherited");
      assert.equal(git(h.remote,"show","refs/tags/grounds/deliveries/"+run.manifest.items[0].id+":result.txt"),"inherited uncommitted note");
      assert.equal(docker("ps","-aq","--filter","label=dev.grounds.sandbox="+run.sandboxId),"");
    } finally {
      for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id);
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
    const materialFile=join(h.directory,"handoff-materials.json");
    const inputs=["one","two"].map(name=>({name,repository:h.repo,commit:h.baseline}));
    writeFileSync(materialFile,JSON.stringify(inputs));
    const spec=["--title","handoff fixture","--criterion","use notes","--environment",environment.environmentId,"--repo-remote",h.remote,"--baseline",h.baseline,"--materials",materialFile];
    const task=ok(await h.cli("task","create",...spec));
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
      writeFileSync(materialFile,JSON.stringify(inputs.reverse()));
      ok(await h.cli("task","revise","--task",task.taskId,"--expected-seq","1",...spec));
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
    const args = ["suite","measure","--suite",suite.suiteId,"--revision","1","--case","example","--run",target.runId,"--delivery",target.deliveryId,"--repo",".","--operation-id",newUUIDv7()];
    const ledger = ok(await h.cli("db","status")).database_id;
    try {
      const admitted = ok(await h.cli(...args));
      assert.deepEqual(ok(await h.cli(...args)),admitted);
      const db = new DatabaseSync(join(h.directory,"ledger.db"));
      try {
        const row = db.prepare("SELECT body_json FROM work_intents WHERE kind='run-test-grader' AND subject_id=?").get(admitted.gradingId);
        assert.equal(JSON.parse(String(row?.body_json)).payload.repository,h.repo);
      } finally { db.close(); }
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
      // Recreate two crash boundaries without launching a background host.
      const opened = await openStore(join(h.directory,"config.yaml"));
      try {
        const {composeWork} = await import("../src/work/composition.js");
        const {DevcontainerRuntime} = await import("../src/work/adapters/devcontainer/runtime.js");
        const {ManagedWorkspaces} = await import("../src/work/adapters/devcontainer/workspace.js");
        const {EvaluatorWorkspaces} = await import("../src/work/adapters/devcontainer/evaluator-workspace.js");
        const {DurableSandboxLauncher} = await import("../src/work/adapters/devcontainer/launch.js");
        const {GitTagArchive} = await import("../src/work/adapters/git/tag-archive.js");
        const app = composeWork(opened.store), runtime = new DevcontainerRuntime(), files = new ManagedWorkspaces();
        for (const boundary of ["saved-plan", "reserved-command"]) {
          const fresh = await app.suites.measure({requestId:newUUIDv7(),suiteId:suite.suiteId,seq:1,caseKey:"example",...target},h.repo);
          assert.ok(fresh.ok);
          const id = fresh.value.gradingId, location = await runtime.location();
          const allocation = await app.tests.allocate(id,location);
          assert.ok(allocation.ok);
          const owner = {ledgerId:ledger,sandboxId:allocation.value.sandboxId,setupAttempt:id};
          if (boundary === "saved-plan") {
            writeFileSync(join(files.setupRoot(owner),"launch.json"),"{}",{mode:0o600});
            const stopped = await app.testDriver.drive(id,false);
            assert.ok(stopped.ok && stopped.value.state === "terminal" && stopped.value.providerStopped);
            assert.equal(ok(await h.cli("grade","show","--grading",id)).status,"grader_fault");
          } else {
            const ctx = await app.tests.context(id);
            assert.ok(ctx.ok);
            const {plan,environment,materials} = ctx.value;
            const ws = await new EvaluatorWorkspaces(files,new GitTagArchive()).prepare(owner,plan,environment,materials);
            await new DurableSandboxLauncher(files).start(owner,ws,location);
            const instance = await files.receipt(owner);
            assert.ok(instance);
            assert.ok((await app.tests.ready(id,instance)).ok && (await app.tests.beginStep(id,0)).ok);
            const awaiting = await app.testDriver.drive(id,false);
            assert.ok(awaiting.ok && awaiting.value.state === "awaiting-resume" && awaiting.value.providerStopped);
            assert.equal((await runtime.observe(owner))?.state,"stopped");
            ok(await h.cli("grade","cancel","--grading",id));
            const deadline = Date.now() + 30_000;
            do {
              status = ok(await h.cli("grade","test-status","--grading",id));
              if (status.host?.state === "terminal") break;
              await new Promise(resolve=>setTimeout(resolve,200));
            } while (Date.now() < deadline);
            assert.equal(status.status,"cancelled");
            assert.equal(status.sandboxPhase,"released");
          }
        }
      } finally { await opened.store.close(); }
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

test("experiment runs two pinned agents on one suite and adopts only member regrades", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const image = process.env.GROUNDS_TEST_MANAGED_AGENT!;
    const docker = (...args:string[]) => execFileSync("docker",args,{encoding:"utf8"}).trim();
    const digest = docker("image","inspect","--format","{{.Id}}",image);
    const config = join(h.directory,"env.json"), cases = join(h.directory,"cases.json");
    writeFileSync(config,JSON.stringify({image,overrideCommand:false,workspaceFolder:"/work"}));
    const env = ok(await h.cli("work","define-environment","--name","bench","--image-digest",digest,"--devcontainer",config));
    const task = ok(await h.cli("task","create","--title","comparison fixture","--criterion","provide expected answer",
      "--environment",env.environmentId,"--repo-remote",h.remote,"--baseline",h.baseline));
    const history = ok(await h.cli("work","start","--task",task.taskId,"--mode","none"));
    writeFileSync(join(h.repo,"expected.txt"),"codex result\n");
    git(h.repo,"add","expected.txt");git(h.repo,"commit","-qm","reference");
    const answer = ok(await h.cli("work","deliver","--run",history.runId,"--repo",h.repo));
    writeFileSync(cases,JSON.stringify([{key:"case",runId:history.runId,deliveryId:answer.delivery.id,
      bindings:[{key:"answer",answerPath:"result.txt",referencePath:"expected.txt"}]}]));
    const suite = ok(await h.cli("suite","publish","--name","compare","--cases-file",cases));
    const ledger = ok(await h.cli("db","status")).database_id;
    try {
      for (const provider of ["codex","claude-code"]) {
        const agent = ok(await h.cli("work","define-agent","--name",provider,"--provider",provider));
        const plan = ok(await h.cli("experiment","define","--name",provider,"--suite",suite.suiteId,"--revision","1",
          "--agent",agent.agentId,"--agent-revision",agent.revisionId,"--repo",h.repo));
        const args = ["experiment","launch","--experiment",plan.experimentId,"--repeat","2","--concurrency","1","--operation-id",newUUIDv7()];
        const launch = ok(await h.cli(...args));
        assert.deepEqual(ok(await h.cli(...args)),launch);
        const deadline = Date.now()+120_000;
        let results;
        do {
          results = ok(await h.cli("experiment","results","--batch",launch.batchId));
          if (["terminal","awaiting-resume","blocked"].includes(results.host?.state)) break;
          await new Promise(resolve=>setTimeout(resolve,250));
        } while (Date.now()<deadline);
        assert.equal(results.host?.state,"terminal",JSON.stringify(results));
        assert.equal(results.counts.fullyGraded,2);
        assert.equal(results.counts.delivered,2);
        assert.deepEqual(results.dimensions[0].categories, provider==="codex" ? {match:2,mismatch:0} : {match:0,mismatch:2});
        const member = results.members[0];
        const original = member.requirements[0].adopted;
        const repeat = ok(await h.cli("experiment","regrade","--batch",launch.batchId,"--member",member.key,"--binding","answer"));
        assert.notEqual(repeat.gradingId,original);
        const detail = ok(await h.cli("experiment","member","--batch",launch.batchId,"--member",member.key));
        assert.equal(detail.member.gradings.length,2);
        assert.equal(detail.member.requirements[0].adopted,repeat.gradingId);
        // Admit the earlier request and hold only its external read. The
        // later request returns first and must still be the adopted record.
        const opened = await openStore(join(h.directory,"config.yaml"));
        let laterId;
        try {
          const {composeWork} = await import("../src/work/composition.js");
          const {ExperimentGrading} = await import("../src/work/application/experiment-grading.js");
          const {SqlWorkUnitOfWork,GitTagArchive} = await import("../src/work/adapters/index.js");
          let reading!:()=>void, release!:()=>void;
          const reached = new Promise<void>(resolve=>{reading=resolve;});
          const held = new Promise<void>(resolve=>{release=resolve;});
          const archive = new class extends GitTagArchive {
            override async fileDigest(...args:Parameters<GitTagArchive["fileDigest"]>) { reading(); await held; return super.fileDigest(...args); }
          }();
          const slow = new ExperimentGrading({units:new SqlWorkUnitOfWork(opened.store),newId:newUUIDv7,now:()=>new Date().toISOString(),
            hash:s=>createHash("sha256").update(s).digest("hex")},archive,composeWork(opened.store).repairs);
          const earlier = slow.measure({batchId:launch.batchId,key:member.key,requirement:"answer",requestId:newUUIDv7()});
          try {
            await reached;
            laterId = ok(await h.cli("experiment","regrade","--batch",launch.batchId,"--member",member.key,"--binding","answer")).gradingId;
          } finally { release(); }
          assert.ok((await earlier).ok);
          const reordered = ok(await h.cli("experiment","member","--batch",launch.batchId,"--member",member.key));
          assert.equal(reordered.member.requirements[0].adopted,laterId);
        } finally {await opened.store.close();}
        renameSync(h.remote,h.remote+"-offline");
        try {
          const failed = ok(await h.cli("experiment","regrade","--batch",launch.batchId,"--member",member.key,"--binding","answer"));
          assert.equal(failed.status,"grader_fault");
          const afterFault = ok(await h.cli("experiment","member","--batch",launch.batchId,"--member",member.key));
          assert.equal(afterFault.member.requirements[0].adopted,laterId);
          assert.equal(afterFault.member.requirements[0].latestFault.id,failed.gradingId);
          assert.equal(afterFault.member.gradings.length,5);
        } finally {renameSync(h.remote+"-offline",h.remote);}
        const interruptedStore = await openStore(join(h.directory,"config.yaml"));
        try {
          const {composeWork} = await import("../src/work/composition.js");
          const {ExperimentGrading} = await import("../src/work/application/experiment-grading.js");
          const {SqlWorkUnitOfWork,GitTagArchive} = await import("../src/work/adapters/index.js");
          const app = composeWork(interruptedStore.store);
          assert.equal(await app.members.note(launch.batchId,"running"),"terminal","late host observation cannot reopen a finished batch");
          let entered!:()=>void, release!:()=>void;
          const inside = new Promise<void>(resolve=>{entered=resolve;}), gate = new Promise<void>(resolve=>{release=resolve;});
          const blocked = new class extends GitTagArchive {
            override async fileDigest(...args:Parameters<GitTagArchive["fileDigest"]>) {entered();await gate;return super.fileDigest(...args);}
          }();
          const slow = new ExperimentGrading({units:new SqlWorkUnitOfWork(interruptedStore.store),newId:newUUIDv7,
            now:()=>new Date().toISOString(),hash:s=>createHash("sha256").update(s).digest("hex")},blocked,app.repairs);
          const grading = slow.measure({batchId:launch.batchId,key:member.key,requirement:"answer",requestId:newUUIDv7()});
          try {
            await inside;
            assert.equal(await app.members.note(launch.batchId,"terminal"),"running","stale terminal observation cannot cross a new grading");
            ok(await h.cli("experiment","cancel","--batch",launch.batchId));
          } finally {release();}
          const cancelled = await grading;
          assert.ok(cancelled.ok && "status" in cancelled.value && cancelled.value.status === "cancelled");
          const after = ok(await h.cli("experiment","results","--batch",launch.batchId));
          assert.deepEqual(after.completion,results.completion);
          assert.equal(after.members[0].requirements[0].adopted,laterId);
        } finally {await interruptedStore.store.close();}
        assert.equal(detail.member.run.retention,"release");
        assert.equal(detail.member.run.workId,undefined);
        assert.equal(ok(await h.cli("experiment","show","--experiment",plan.experimentId)).batches.length,1);
        await withRuntimeLock(join(dataLayout().runtime,"managed-host"),"execution-"+launch.batchId,async()=>{},10_000);
      }
    } finally { for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id); }
  });
});

test("experiment runs reconcile after controller loss and cancel only their own workers and supplementary tests", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const docker = (...args:string[]) => execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    const image = process.env.GROUNDS_TEST_MANAGED_AGENT!, ledger = ok(await h.cli("db","status")).database_id;
    const cfg = join(h.directory,"env.json"), cases = join(h.directory,"suite.json"), command = join(h.directory,"commands.json");
    writeFileSync(cfg,JSON.stringify({image,overrideCommand:false,workspaceFolder:"/work"}));
    const environment = ok(await h.cli("work","define-environment","--name","controlled","--image-digest",docker("image","inspect","--format","{{.Id}}",image),"--devcontainer",cfg));
    const agent = ok(await h.cli("work","define-agent","--name","worker","--provider","codex"));
    const task = ok(await h.cli("task","create","--title","controlled batch fixture","--criterion","committed","--repo-remote",h.remote,"--baseline",h.baseline,"--environment",environment.environmentId));
    const historical = ok(await h.cli("work","start","--mode","none","--task",task.taskId));
    const delivered = ok(await h.cli("work","deliver","--run",historical.runId,"--repo",h.repo));
    writeFileSync(command,JSON.stringify([["sh","-c","touch /tmp/test-ready; while [ ! -f /tmp/test-release ]; do sleep 0.1; done"]]));
    const grader = ok(await h.cli("grade","define-test","--commands",command,"--name","controlled test","--environment",environment.environmentId,
      "--environment-revision",environment.revisionId,"--pass","pass","--fail","fail"));
    writeFileSync(cases,JSON.stringify([{key:"c",runId:historical.runId,deliveryId:delivered.delivery.id,bindings:[{key:"quality",grader:{definitionId:grader.graderId,revisionId:grader.revisionId}}]}]));
    const suite = ok(await h.cli("suite","publish","--name","controlled suite","--cases-file",cases));
    const experiment = ok(await h.cli("experiment","define","--name","faults","--suite",suite.suiteId,"--revision","1","--agent",agent.agentId,"--agent-revision",agent.revisionId));
    const launch = async (n:number) => ok(await h.cli("experiment","launch","--experiment",experiment.experimentId,"--repeat",String(n),"--concurrency","1")).batchId;
    const view = async (id:string) => ok(await h.cli("experiment","results","--batch",id));
    const detail = async (id:string,key:string) => ok(await h.cli("experiment","member","--batch",id,"--member",key)).member;
    async function until<T>(read:()=>Promise<T>,done:(v:T)=>boolean) {
      const deadline=Date.now()+75_000;
      let v;
      do {v=await read();if(done(v)) return v; await new Promise(resolve=>setTimeout(resolve,250));} while(Date.now()<deadline);
      throw new Error("timed out: "+JSON.stringify(v));
    }
    const ready = async (batch:string,repeat:number,role:"worker"|"test") => until(async()=>{
      const member = (await view(batch)).members[repeat];
      if (!member?.runId) return "";
      const m = await detail(batch,member.key);
      const sandbox = role === "worker" ? m.run.sandboxId : m.gradings.at(-1)?.sandboxId;
      if (!sandbox) return "";
      const id = docker("ps","-q","--filter","label=dev.grounds.sandbox="+sandbox);
      try { if (id) { docker("exec",id,"test","-f","/tmp/"+role+"-ready"); return id; } } catch {}
      return "";
    },Boolean);
    try {
      const first = await launch(3), unrelated = await launch(1);
      const worker = await ready(first,0,"worker"), independent = await ready(unrelated,0,"worker");
      const owner = JSON.parse(readFileSync(join(hostDirectory("batches"),first),"utf8"));
      assert.equal(signalHostProcessLeader(owner.pid,owner.birth,"SIGKILL"),true);
      docker("exec",worker,"touch","/tmp/worker-release");
      const paused = await until(()=>view(first),v=>v.counts.delivered===1 && v.host?.state==="awaiting-resume");
      assert.equal(paused.counts.pending,2);
      assert.equal(paused.members[0].requirements[0].attempts,0);
      ok(await h.cli("experiment","resume","--batch",first,"--operation-id",first));
      await ready(first,1,"worker");
      await ready(first,0,"test");
      ok(await h.cli("experiment","cancel","--batch",first));
      const ended = await until(()=>view(first),v=>v.host?.state==="terminal");
      assert.equal(ended.counts.cancelled,1);assert.equal(ended.counts.delivered,1);assert.equal(ended.counts.pending,1);
      assert.equal(ended.members[2].requirements[0].notStarted,"batch-cancelled");
      assert.equal((await detail(first,ended.members[0].key)).gradings[0].status,"cancelled");
      docker("exec",independent,"touch","/tmp/worker-release");
      docker("exec",await ready(unrelated,0,"test"),"touch","/tmp/test-release");
      const completed = await until(()=>view(unrelated),v=>v.host?.state==="terminal");
      const key = completed.members[0].key, adopted = completed.members[0].requirements[0].adopted;
      const original = (await detail(unrelated,key)).run.manifest.items[0];
      const repairSource = join(h.directory,"member-repair.git");
      git(h.directory,"clone","--bare","--quiet",h.remote,repairSource);
      git(h.remote,"update-ref","-d","refs/tags/grounds/deliveries/"+original.id);
      ok(await h.cli("work","repair","--run",completed.members[0].runId,"--delivery",original.id,"--repo",repairSource));
      ok(await h.cli("experiment","regrade","--batch",unrelated,"--member",key,"--binding","quality"));
      await ready(unrelated,0,"test");
      ok(await h.cli("experiment","cancel","--batch",unrelated,"--operation-id",unrelated));
      await until(()=>view(unrelated),v=>v.host?.state==="terminal" && !!v.batch.cancelIntent);
      const final = await detail(unrelated,key);
      assert.equal(final.gradings.at(-1).status,"cancelled");
      assert.equal(final.requirements[0].adopted,adopted);
    } finally { for (const id of docker("ps","-aq","--filter","label=dev.grounds.ledger="+ledger).split("\n").filter(Boolean)) docker("rm","-f",id); }
  });
});

test("experiment runs rule and sandbox test graders against the selected working artifact slot", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8"}).trim();
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!, config=join(h.directory,"env.json"), material=join(h.directory,"materials.json");
    const cases=join(h.directory,"cases.json"),commands=join(h.directory,"commands.json");
    writeFileSync(config,JSON.stringify({image,workspaceFolder:"/work"}));
    writeFileSync(material,JSON.stringify([{name:"input",repository:h.repo,commit:h.baseline}]));
    const env=ok(await h.cli("work","define-environment","--name","grader and worker","--devcontainer",config,"--image-digest",docker("image","inspect","--format","{{.Id}}",image)));
    const task=ok(await h.cli("task","create","--kind","working","--title","artifact experiment","--criterion","matches input","--required-output","report","--optional-output","chart","--environment",env.environmentId,"--materials",material));
    const {runId}=ok(await h.cli("work","start","--task",task.taskId,"--mode","none"));
    const {artifact}=ok(await h.cli("work","save-artifact","--run",runId,"--slot","report","--file","report.txt=app.txt"));
    const chart=ok(await h.cli("work","save-artifact","--run",runId,"--slot","chart","--file","chart.txt=app.txt")).artifact;
    ok(await h.cli("work","submit-artifacts","--run",runId,"--artifact",artifact.id,"--artifact",chart.id));
    const rule=ok(await h.cli("grade","define-rule","--name","exact bytes","--rule","equal-file-bytes","--pass","identical","--fail","different"));
    writeFileSync(commands,JSON.stringify([["sh","-c","test ! -d .git && cmp report.txt /grounds-grader/report.txt"]]));
    const grader=ok(await h.cli("grade","define-test","--name","compare file","--commands",commands,"--environment",env.environmentId,"--environment-revision",env.revisionId,"--pass","pass","--fail","fail"));
    const judgeAgent=ok(await h.cli("work","define-agent","--name","report judge","--provider","claude-code"));
    const scale=join(h.directory,"numeric.json");writeFileSync(scale,JSON.stringify({form:"numeric",min:0,max:5}));
    const judge=ok(await h.cli("grade","define-agent","--name","numeric report","--agent",judgeAgent.agentId,"--agent-revision",judgeAgent.revisionId,
      "--environment",env.environmentId,"--environment-revision",env.revisionId,"--rubric","exact report","--scale",scale));
    writeFileSync(cases,JSON.stringify([{key:"report",runId,deliveryId:artifact.id,bindings:[
      {key:"rule",answerPath:"report.txt",referencePath:"report.txt",grader:{definitionId:rule.graderId,revisionId:rule.revisionId}},
      {key:"numeric",referencePath:"report.txt",grader:{definitionId:judge.graderId,revisionId:judge.revisionId}},
      {key:"test",hiddenTestPaths:["report.txt"],grader:{definitionId:grader.graderId,revisionId:grader.revisionId}}
    ]},{key:"optional",runId,deliveryId:chart.id,bindings:[{key:"chart",answerPath:"chart.txt",referencePath:"chart.txt",grader:{definitionId:rule.graderId,revisionId:rule.revisionId}}]}]));
    const suite=ok(await h.cli("suite","publish","--name","working reports","--cases-file",cases));
    const agent=ok(await h.cli("work","define-agent","--name","report author","--provider","codex"));
    const plan=ok(await h.cli("experiment","define","--suite",suite.suiteId,"--revision","1","--agent",agent.agentId,"--agent-revision",agent.revisionId,"--name","working comparison"));
    const {batchId}=ok(await h.cli("experiment","launch","--experiment",plan.experimentId));
    const controllers=[batchId];
    try {
      const end=Date.now()+75000;
      let result;
      do {
        result=ok(await h.cli("experiment","results","--batch",batchId));
        if (result.host?.state==="terminal" || result.host?.state==="blocked") break;
        await new Promise(resolve=>setTimeout(resolve,300));
      } while(Date.now()<end);
      assert.equal(result.host?.state,"terminal",JSON.stringify(result));
      assert.equal(result.counts.fullyGraded,1,JSON.stringify(result));
      assert.equal(result.counts.delivered,2);
      assert.equal(result.members.find((m:{caseKey:string})=>m.caseKey==="optional").requirements[0].notStarted,"target-missing");
      const report=result.members.find((m:{caseKey:string})=>m.caseKey==="report");
      const {member}=ok(await h.cli("experiment","member","--batch",batchId,"--member",report.key));
      assert.equal(result.dimensions.find((d:{requirement:string})=>d.requirement==="numeric").numericMean,5);
      assert.deepEqual(member.gradings.filter((g:{grade:{form:string}})=>g.grade.form==="category").map((g:{grade:{category:string}})=>g.grade.category).sort(),["identical","pass"]);
      assert.ok(member.gradings.every((g:{targets:{type:string;id:string}[]})=>g.targets[0]?.type==="artifact" && g.targets[0].id!==artifact.id));
      const id=member.gradings[0].targets[0].id, saved=ok(await h.cli("work","artifact","--run",member.runId,"--artifact",id)).artifact;
      const appendix=saved.files.find((file:{path:string})=>file.path==="appendix.txt").content.digest;
      const {store}=await openStore(join(h.directory,"config.yaml"));
      try {
        await store.transaction(true,c=>c.run("DELETE FROM work_evidence_chunks WHERE digest=?",[appendix]));
        const regrade=["experiment","regrade","--batch",batchId,"--member",report.key,"--binding"];
        assert.equal(ok(await h.cli(...regrade,"rule")).status,"grader_fault");
        const accepted=ok(await h.cli(...regrade,"test"));
        controllers.unshift(accepted.gradingId);
        let status;
        do {
          status=ok(await h.cli("grade","test-status","--grading",accepted.gradingId));
          if (status.status==="grader_fault") break;
          await new Promise(resolve=>setTimeout(resolve,250));
        } while(Date.now()<end);
        assert.equal(status.status,"grader_fault",JSON.stringify(status));
        await store.transaction(true,c=>c.run("UPDATE work_intents SET record_digest=? WHERE request_id=? AND kind='save-artifact'",["sha256:"+"0".repeat(64),id]));
        const damaged=ok(await h.cli("experiment","member","--batch",batchId,"--member",report.key)).member;
        assert.equal(damaged.targetAvailability,"unavailable");assert.equal(damaged.complete,true);
        await store.transaction(true,c=>c.run("DELETE FROM work_intents WHERE request_id=? AND kind='save-artifact'",[id]));
        const after=ok(await h.cli("experiment","member","--batch",batchId,"--member",report.key)).member;
        assert.equal(after.targetAvailability,"unavailable");
        assert.deepEqual(after.requirements.map((v:{adopted:string})=>v.adopted),member.requirements.map((v:{adopted:string})=>v.adopted));
        assert.equal(after.requirements.filter((v:{key:string})=>v.key!=="numeric").every((v:{latestFault?:unknown})=>!!v.latestFault),true);
        assert.equal(ok(await h.cli("experiment","results","--batch",batchId)).counts.fullyGraded,1);
      } finally {await store.close();}
    } finally {
      // Results can become durable before their controllers finish housekeeping.
      const host=join(dataLayout().runtime,"managed-host");
      for (const id of controllers) await withRuntimeLock(host,"execution-"+id,async()=>{},30000);
      await withRuntimeLock(host,"host",async()=>{},30000);
    }
  });
});

test("managed evaluator runs in a fresh grading sandbox and returns a numeric zero", {skip:!process.env.GROUNDS_TEST_MANAGED_AGENT},async()=>{
  await withHarness(async h=>{
    const image=process.env.GROUNDS_TEST_MANAGED_AGENT!, cfg=join(h.directory,"evaluator-env.json"),scale=join(h.directory,"rubric-scale.json"),cases=join(h.directory,"judge-cases.json");
    writeFileSync(cfg,JSON.stringify({image,workspaceFolder:"/review"}));
    writeFileSync(scale,JSON.stringify({form:"numeric",min:0,max:5}));
    const digest=execFileSync("docker",["image","inspect","--format","{{.Id}}",image],{encoding:"utf8"}).trim();
    const environment=ok(await h.cli("work","define-environment","--name","evaluation","--devcontainer",cfg,"--image-digest",digest));
    const task=ok(await h.cli("task","create","--kind","working","--title","Report","--criterion","accuracy","--required-output","answer","--optional-output","key"));
    const runId=ok(await h.cli("work","start","--task",task.taskId,"--mode","none")).runId;
    writeFileSync(join(h.repo,"answer"),"incorrect");writeFileSync(join(h.repo,"reference"),"correct");
    writeFileSync(join(h.repo,"project-settings"),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:"command",command:"touch /tmp/untrusted-hook"}]}]}}));
    const save=async(slot:string,...files:string[])=>ok(await h.cli("work","save-artifact","--run",runId,"--slot",slot,...files.flatMap(file=>["--file",file]))).artifact.id;
    const answer=await save("answer","answer.txt=answer",".claude/settings.json=project-settings"),key=await save("key","reference.txt=reference");
    ok(await h.cli("work","submit-artifacts","--run",runId,"--artifact",answer,"--artifact",key));
    const agent=ok(await h.cli("work","define-agent","--provider","claude-code","--name","reviewer"));
    const publications=[];
    for(const rubric of ["Grade the submitted answer against the reference","invalid grade","wait to cancel"]) {
      publications.push(ok(await h.cli("grade","define-agent","--name","accuracy","--agent",agent.agentId,"--agent-revision",agent.revisionId,
        "--environment",environment.environmentId,"--environment-revision",environment.revisionId,"--rubric",rubric,"--scale",scale)));
    }
    writeFileSync(cases,JSON.stringify([{key:"case",runId,deliveryId:answer,bindings:publications.map((g,index)=>({
      key:String(index),grader:{definitionId:g.graderId,revisionId:g.revisionId},materialSource:{runId,deliveryId:key},referencePath:"reference.txt"}))}]));
    const suite=ok(await h.cli("suite","publish","--name","judge","--cases-file",cases));
    for(const index of ["0","1","2"]) {
      const accepted=ok(await h.cli("suite","measure","--suite",suite.suiteId,"--revision","1","--case","case","--binding",index,"--run",runId,"--delivery",answer));
      const end=Date.now()+45000;
      if (index==="2") {
        let ready=false;
        while(Date.now()<end && !ready) {
          const g=ok(await h.cli("grade","show","--grading",accepted.gradingId));
          if(g.sandboxId) {
            const id=execFileSync("docker",["ps","-q","--filter","label=dev.grounds.sandbox="+g.sandboxId],{encoding:"utf8"}).trim();
            if(id) try {execFileSync("docker",["exec",id,"test","-f","/tmp/grounds-judge-ready"],{stdio:"ignore"});ready=true;} catch {}
          }
          if(!ready) await new Promise(resolve=>setTimeout(resolve,200));
        }
        assert.ok(ready,"evaluator reached its cancellation barrier");
        ok(await h.cli("grade","cancel","--grading",accepted.gradingId));
      }
      let status;
      do {
        status=ok(await h.cli("grade","evaluator-status","--grading",accepted.gradingId));
        if (status.sandboxPhase==="released" || status.host?.state==="blocked") break;
        await new Promise(resolve=>setTimeout(resolve,250));
      } while(Date.now()<end);
      assert.equal(status.sandboxPhase,"released",JSON.stringify(status));
      const score=ok(await h.cli("grade","show","--grading",accepted.gradingId));
      assert.equal(score.status,index==="0" ? "completed" : index==="1" ? "grader_fault" : "cancelled");
      if (index==="2") {
        assert.equal(score.evaluatorStopped,true);
        const partial=ok(await h.cli("grade","evaluator-evidence","--grading",accepted.gradingId,"--stream","raw","--chunk","0"));
        assert.match(Buffer.from(partial.base64,"base64").toString(),/partial-cancelled-evaluation/);
        continue;
      }
      const trace=ok(await h.cli("grade","evaluator-evidence","--grading",accepted.gradingId,"--stream","raw","--chunk","0"));
      assert.equal(trace.executionId,score.evaluator.executionId);
      assert.match(Buffer.from(trace.base64,"base64").toString(),/independent-evaluator/);
      assert.equal(score.evaluator.kind,"agent");assert.equal(score.evaluatorStopped,true);
      if(index==="0") assert.deepEqual(score.grade,{form:"numeric",value:0});
      else assert.equal(score.grade,undefined);
    }
  });
});
