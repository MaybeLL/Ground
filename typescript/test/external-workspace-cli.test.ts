import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LedgerFixture, testAgent } from "./fixture.js";
import { SQLStore } from "../src/sql-store.js";
import { writeConfig } from "../src/config.js";
import { trustedGit } from "../src/frozen-checkout.js";
import { newUUIDv7 } from "../src/identity.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { assertContract } from "./schema-fixture.js";

for (const mode of ["candidate", "abandon"] as const) test(`public CLI external ${mode} preserves user input and ownership`, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-external-cli-"))), project = join(root, "project"), home = join(root, "home"), database = join(root, "ledger.db");
  mkdirSync(project); mkdirSync(home, { mode: 0o700 });
  const store = SQLStore.sqlite(database), f = await LedgerFixture.createWithStore(store);
  try {
    const git = (...args: string[]) => trustedGit(project, args);
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("remote", "add", "origin", f.repository.canonical_remote);
    writeFileSync(join(project, "file.txt"), "baseline\n"); git("add", "."); git("commit", "-qm", "baseline");
    const baseline = "sha1:" + git("rev-parse", "HEAD");
    const remote = join(root, "remote.git"); execFileSync("git", ["init", "--bare", "-q", remote]);
    execFileSync("git", ["push", remote, "HEAD:refs/heads/main"], { cwd: project, stdio: "pipe" });
    const transport = archiveCLITransport(t, root, remote, f.repository.repository_id);
    const issue = await f.module.createIssue({ operation_id: newUUIDv7(), attribution: testAgent, requirement_id: f.requirement.requirement_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, repository_id: f.repository.repository_id,
      baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "fixture", override_reason: "fixture" }, input: { format: 1, summary: "外部目录接入", goals: [{ statement: "保存修改", criteria: ["文件修改可捕获"], traces_to: [{ type: "outcome", ordinal: 1 }] }] } });
    const config = join(root, "config.yaml"); writeConfig(config, { version: 2, database: { driver: "sqlite", path: database, expected_database_id: (await store.inspect()).database_id } });
    const bin = resolve("src/main.ts");
    const cli = (args: string[]) => {
      let text: string;
      try { text = execFileSync(process.execPath, ["--import", "tsx", bin, ...args, "--config", config, "--cwd", project, "--json"], { cwd: resolve("."), env: { ...process.env, PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" }, encoding: "utf8", timeout: 30000 }); }
      catch (error: any) { throw Error(String(error.stdout ?? error.message)); }
      const e = JSON.parse(text); assert.equal(e.ok, true, text); assertContract("command-results.schema.json", e.data); return e.data;
    };
    writeFileSync(join(project, "file.txt"), "existing user change\n");
    const preview = cli(["devrun", "inspect-workspace", issue.result.issue_id, "--directory", project]);
    assert.equal(preview.workspace.dirty, true);
    const start = cli(["devrun", "start", "--development-mode", "simple", issue.result.issue_id, "--external-directory", project, "--input-digest", preview.workspace.input_digest, "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name]);
    assert.equal(start.local_worktree.path, project); assert.equal(start.local_worktree.ownership, "external");
    const id = start.context.dev_run.id;
    if (mode === "abandon") {
      const activeContext = cli(["devrun", "context", id]);
      assert.equal(activeContext.local_worktree.ownership, "external");
      assert.equal(activeContext.local_worktree.input_digest, preview.workspace.input_digest);
      cli(["devrun", "abandon", id, "--expected-version", "1", "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name]);
      const cleaned = cli(["devrun", "cleanup", id, "--discard-changes"]);
      assert.equal(cleaned.external_preserved, true);
      assert.equal(readFileSync(join(project, "file.txt"), "utf8"), "existing user change\n");
      assert.equal(git("rev-parse", "HEAD"), baseline.slice(5));
      return;
    }
    writeFileSync(join(project, "later.txt"), "new task change\n");
    trustedGit(project, ["add", "-A"]); trustedGit(project, ["commit", "-qm", "fixed candidate"]);
    const candidateSource = trustedGit(project, ["rev-parse", "HEAD"]);
    const template = cli(["candidate", "template", id, "--content-language", "zh-CN"]);
    const s = template.submission;
    s.explanation = "临时外部目录通过公开接口捕获并提交代码，明确保留用户既有输入。";
    for (const claim of s.claims) {
      claim.explanation = "真实文件读取与规范工件捕获验证本目标。";
      for (const cr of claim.criteria) { cr.explanation = "用户既有文件及新增文件均被捕获，输入来源明确。"; cr.evidence = [{ type: "observation", statement: "外部目录文件存在且符合固定基线差异。", attribution: testAgent }]; cr.self_verification = { status: "satisfied", method: "公开CLI与文件读取", explanation: "规范工件已捕获且文件保留。" }; }
    }
    for (const rationale of s.change_rationales) { rationale.rationale = "捕获该文件相对基线的差异，用户原有输入不冒称本次Agent创作。"; rationale.relation = "implements"; rationale.target_refs = [{ type: "criterion", id: s.claims[0].criteria[0].criterion_id }]; rationale.alternatives = []; rationale.risks = []; }
    const file = join(root, "submission.json"); writeFileSync(file, JSON.stringify(s));
    const result = cli(["candidate", "submit", id, "--archive-policy", transport.policy(), "--file", file, "--expected-version", "1", "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name, "--content-language", "zh-CN"]);
    assert.ok(result.candidate_id);
    const cleaned = cli(["devrun", "cleanup", id, "--discard-changes"]);
    assert.equal(cleaned.removed, false); assert.equal(cleaned.external_preserved, true);
    // Detaching a user-owned directory is not a deletion: no removal event and no summary.
    assert.equal("deletion_summary" in cleaned, false);
    const ledger = new DatabaseSync(database);
    try { assert.equal((ledger.prepare("SELECT count(*) AS n FROM ledger_events WHERE event_type = 'devrun.worktree_removed'").get() as { n: number }).n, 0); } finally { ledger.close(); }
    assert.equal(readFileSync(join(project, "file.txt"), "utf8"), "existing user change\n");
    assert.equal(readFileSync(join(project, "later.txt"), "utf8"), "new task change\n");
    assert.equal(git("rev-parse", "HEAD"), candidateSource);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
