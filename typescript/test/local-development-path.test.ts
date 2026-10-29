import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LedgerFixture, testAgent } from "./fixture.js";
import { SQLStore } from "../src/sql-store.js";
import { writeConfig } from "../src/config.js";
import { trustedGit } from "../src/frozen-checkout.js";
import { newUUIDv7 } from "../src/identity.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { assertContract } from "./schema-fixture.js";

test("local direct development completes DevRun to Candidate without Docker or managed launcher", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-local-direct-"))), project = join(root, "project"), home = join(root, "home"), database = join(root, "ledger.db");
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
      baseline: { git_oid: baseline, reachability: "unconfirmed", warning: "fixture", override_reason: "fixture" }, input: { format: 1, summary: "本机直接开发", goals: [{ statement: "保存修改", criteria: ["文件修改可捕获"], traces_to: [{ type: "outcome", ordinal: 1 }] }] } });
    const config = join(root, "config.yaml"); writeConfig(config, { version: 2, database: { driver: "sqlite", path: database, expected_database_id: (await store.inspect()).database_id } });
    const bin = resolve("src/main.ts"), tools = join(root, "tools"), invoked = join(root, "unexpected-launch");
    mkdirSync(tools);
    for (const name of ["docker", "colima", "codex"]) writeFileSync(join(tools, name), `#!/bin/sh\nprintf '%s' '${name}' >> '${invoked}'\nexit 99\n`, { mode: 0o700 });
    const cli = (args: string[]) => {
      let text: string;
      try { text = execFileSync(process.execPath, ["--import", "tsx", bin, ...args, "--config", config, "--cwd", project, "--json"], { cwd: resolve("."), env: { ...process.env, PATH: tools + ":" + process.env.PATH, HOME: home, LANG: "C.UTF-8" }, encoding: "utf8", timeout: 30000 }); }
      catch (error: any) { throw Error(String(error.stdout ?? error.message)); }
      const e = JSON.parse(text); assert.equal(e.ok, true, text); assertContract("command-results.schema.json", e.data); return e.data;
    };
    const start = cli(["devrun", "start", "--development-mode", "simple", issue.result.issue_id, "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name]);
    const worktree = start.local_worktree.path, id = start.context.dev_run.id;
    assert.equal(start.local_worktree.status, "available");
    assert.notEqual(worktree, project);
    assert.equal(cli(["devrun", "context", id]).local_worktree.path, worktree);
    assert.equal(trustedGit(worktree, ["rev-parse", "HEAD"]), baseline.slice(5));
    assert.equal(trustedGit(worktree, ["branch", "--show-current"]), "");
    writeFileSync(join(worktree, "later.txt"), "new task change\n");
    trustedGit(worktree, ["add", "-A"]); trustedGit(worktree, ["commit", "-qm", "fixed candidate"]);
    const candidateSource = trustedGit(worktree, ["rev-parse", "HEAD"]);
    const template = cli(["candidate", "template", id, "--content-language", "zh-CN"]);
    const s = template.submission;
    s.explanation = "当前 Agent 在独立工作树直接开发，通过公开 CLI 捕获并提交。";
    for (const claim of s.claims) {
      claim.explanation = "真实文件读取与规范工件捕获验证本目标。";
      for (const cr of claim.criteria) { cr.explanation = "新增文件被捕获，原 clone 保持不变。"; cr.evidence = [{ type: "observation", statement: "本机工作树文件存在且符合固定基线差异。", attribution: testAgent }]; cr.self_verification = { status: "satisfied", method: "公开CLI与文件读取", explanation: "规范工件已捕获且文件保留。" }; }
    }
    for (const rationale of s.change_rationales) { rationale.rationale = "捕获当前 Agent 直接写入的文件相对基线的差异。"; rationale.relation = "implements"; rationale.target_refs = [{ type: "criterion", id: s.claims[0].criteria[0].criterion_id }]; rationale.alternatives = []; rationale.risks = []; }
    const file = join(root, "submission.json"); writeFileSync(file, JSON.stringify(s));
    const result = cli(["candidate", "submit", id, "--archive-policy", transport.policy(), "--file", file, "--expected-version", "1", "--agent-id", testAgent.agent_id, "--agent-name", testAgent.display_name, "--content-language", "zh-CN"]);
    assert.ok(result.candidate_id);
    const shown = cli(["candidate", "show", result.candidate_id]);
    assert.equal(shown.candidate.candidate_id, result.candidate_id);
    assert.equal(readFileSync(join(project, "file.txt"), "utf8"), "baseline\n");
    assert.equal(readFileSync(join(worktree, "later.txt"), "utf8"), "new task change\n");
    assert.equal(existsSync(invoked), false, "direct development must not invoke Docker or any managed Agent launcher");
    assert.equal(git("rev-parse", "HEAD"), baseline.slice(5));
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
