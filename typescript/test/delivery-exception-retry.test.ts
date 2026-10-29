import { archiveCLITransport } from "./archive-cli-fixture.js";
import { deriveLocalGitArtifact } from "../src/git-artifact-local.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCLI, commandNeedsOperationID, parseArgs } from "../src/cli.js";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { SQLStore } from "../src/sql-store.js";
import { newUUIDv7 } from "../src/identity.js";
import { resolveBaseline } from "../src/git.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { isolatedPostgres, postgresEnabled } from "./isolated-postgres.js";
import { PreflightService } from "../src/preflight.js";
import { establishPreflight, reviseTargetIssue } from "./preflight-fixture.js";

// Deterministic standing fixtures exercise retry policy only. These are not
// genuine independent judgements or the separately coordinated through run.
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
async function fixture(t: { after(f: () => Promise<void>): void }, driver: "sqlite" | "mysql" | "postgres") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-exception-retry-"))), cwd = join(root, "repo"), remote = join(root, "origin.git");
  git(root, "init", "--bare", "-q", remote); git(root, "init", "-qb", "main", cwd);
  git(cwd, "config", "user.name", "Retry Test"); git(cwd, "config", "user.email", "retry@invalid");
  git(cwd, "remote", "add", "origin", "ssh://git@example.test/team/repo"); git(cwd, "config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/repo");
  writeFileSync(join(cwd, ".gitignore"), ".grounds/\n"); writeFileSync(join(cwd, "feature"), "base\n"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "base"); git(cwd, "push", remote, "HEAD:refs/heads/main"); git(cwd, "fetch", "origin");
  const base = resolveBaseline(cwd, "HEAD"), databasePath = join(root, "ledger.db");
  const pg = driver === "postgres" ? await isolatedPostgres() : undefined;
  const settings = pg ? { host: pg.connection.host, port: pg.connection.port, database: pg.database, username: pg.connection.username, password: pg.connection.password, caFile: pg.connection.caFile } : { host: process.env.GROUNDS_TEST_MYSQL_HOST!, port: Number(process.env.GROUNDS_TEST_MYSQL_PORT ?? 3306), database: process.env.GROUNDS_TEST_MYSQL_DATABASE!, username: process.env.GROUNDS_TEST_MYSQL_USERNAME!, password: process.env.GROUNDS_TEST_MYSQL_PASSWORD!, caFile: process.env.GROUNDS_TEST_MYSQL_CA_FILE! };
  const store = pg ? pg.store : driver === "sqlite" ? SQLStore.sqlite(databasePath) : SQLStore.mysql(settings);
  const f = await LedgerFixture.createWithStore(store, pg?.cleanup ?? (() => store.close()), { preflightCoordinator: new PreflightService(store, cwd).coordinator({ refresh: true }) });
  const passwordVariable = driver === "postgres" ? "GROUNDS_POSTGRES_PASSWORD" : "GROUNDS_MYSQL_PASSWORD";
  const previousPassword = process.env[passwordVariable];
  if (driver !== "sqlite") process.env[passwordVariable] = settings.password;
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); if (previousPassword === undefined) delete process.env[passwordVariable]; else process.env[passwordVariable] = previousPassword; });
  const revised = await reviseTargetIssue(f.module, f.store, cwd, { operation_id: newUUIDv7(), attribution: testAgent, issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: base, reachability: "remote_tracking_reachable" }, input: { format: 1, summary: "交付重试夹具", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "固定候选", criteria: ["代码可用"] }] } });
  await establishPreflight(f.store, cwd, { issueId: f.issue.issue_id, issueRevisionId: revised.result.issue_revision_id, repositoryId: f.repository.repository_id });
  const database = (await f.store.inspect()).database_id, config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: driver === "sqlite" ? { driver, path: databasePath, expected_database_id: database } : { driver, host: settings.host, port: settings.port, database: settings.database, username: settings.username, tls: { mode: "verify_identity", ca_file: settings.caFile }, password: { source: "environment", variable: passwordVariable }, expected_database_id: database } }));
  const transport = archiveCLITransport(t, root, remote, f.repository.repository_id), archivePolicy = transport.policy();
  git(cwd, "config", "--unset", `url.file://${remote}.insteadOf`);
  store.setGitArtifactResolver(ref => deriveLocalGitArtifact(cwd, ref.git_artifact!.binding));
  const invoke = async (args: string[], agent = "retry-author") => {
    const output: string[] = [], write = commandNeedsOperationID(parseArgs(args));
    const flags = write ? [...(!args.includes("--operation-id") ? ["--operation-id", newUUIDv7()] : []), "--agent-id", agent, "--agent-name", "重试夹具角色"] : [];
    const code = await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => runCLI([...args, ...flags, "--config", config, "--json"], { cwd, stdout: s => output.push(s), stderr: () => {} }));
    return { code, envelope: JSON.parse(output.join("\n")) };
  };
  const ok = async (args: string[], agent?: string) => { const r = await invoke(args, agent); assert.equal(r.code, 0, JSON.stringify(r.envelope)); return r.envelope.data; };
  const plan = await ok(["devrun", "plan", "--issue-slug", "fixture", "--repository", f.repository.repository_id, "--definition-commit", base, "--target-remote", "origin", "--target-branch", "refs/heads/main", "--operation-id", newUUIDv7()]);
  const run = await ok(["devrun", "start", "--development-mode", "simple", "--issue", f.issue.issue_id, "--plan", plan.plan.workspace_id, "--refresh"]);
  writeFileSync(join(plan.plan.path, "feature"), "candidate\n"); git(plan.plan.path, "add", "."); git(plan.plan.path, "commit", "-qm", "candidate");
  const template = await ok(["candidate", "template", "--dev-run", run.context.dev_run.id]); const submission = template.submission;
  submission.explanation = "实现临时重试测试代码";
  for (const c of submission.claims) { c.explanation = "测试固定候选"; for (const q of c.criteria) { q.explanation = "实现临时功能"; q.self_verification = { status: "not_verified", explanation: "本夹具不代表实际独立验收" }; } }
  for (const q of submission.change_rationales) { q.relation = "implements"; q.target_refs = [{ type: "criterion", id: submission.claims[0].criteria[0].criterion_id }]; q.rationale = "将固定代码用于隔离的重试门禁测试"; }
  const file = join(root, "submission.json"); writeFileSync(file, JSON.stringify(submission));
  const candidate = await ok(["candidate", "submit", "--dev-run", run.context.dev_run.id, "--expected-version", "1", "--file", file, "--archive-policy", archivePolicy]);
  const chosen = await ok(["selection", "set", "--issue", f.issue.issue_id, "--issue-version", "2", "--candidate", candidate.candidate_id, "--expected-version", "0", "--reason", "临时重试测试选择"]);
  const verdict = async (value: "qualified" | "rejected" | "inconclusive") => {
    const blind = (await ok(["verification", "context", "--candidate", candidate.candidate_id, "--phase", "blind"])).context;
    const report = { format: "patchledger.verification-report/v1", candidate_id: candidate.candidate_id, result_tree_oid: candidate.result_tree_oid, blind_context_digest: blind.blind_context_digest,
      assessments: submission.claims.map((c: any) => ({ target_type: c.target_type, target_id: c.target_id, criteria: c.criteria.map((q: any) => ({ criterion_id: q.criterion_id, independent: { verdict: value, explanation: "仅供当前standing重试边界的确定性夹具", evidence: [] }, reconciliation: { claim_relation: "corroborated", explanation: "夹具状态，不是模型独立判断" }, final: { verdict: value, explanation: "仅供门禁状态回归" } })) })) };
    const path = join(root, `${newUUIDv7()}.json`); writeFileSync(path, JSON.stringify(report)); await ok(["verification", "submit", "--candidate", candidate.candidate_id, "--file", path], "retry-fixture-verifier");
  };
  const op = newUUIDv7(), branch = "grounds/retry-exit", target = join(root, "delivery");
  const materialize = (version = "1", operation = op) => invoke(["selection", "materialize", "--issue", f.issue.issue_id, "--issue-version", "2", "--expected-version", version, "--path", target, "--branch", branch, "--allow-unverified", "--reason", "只接受这个固定准备的未验证披露", "--operation-id", operation]);
  git(cwd, "branch", branch, base.slice(5)); const failed = await materialize(); assert.notEqual(failed.code, 0); assert.equal(existsSync(target), false);
  const audit = await f.store.read(tx => tx.getOperation(op)); assert.ok(audit); git(cwd, "branch", "-D", branch);
  return { root, cwd, remote, f, base, candidate, chosen, invoke, ok, verdict, op, target, materialize, audit, issue: f.issue.issue_id, revision: revised.result.issue_revision_id };
}

for (const driver of ["sqlite", "mysql", "postgres"] as const) for (const scenario of ["rejected", "disputed", "inconclusive", "selection", "source", "target", "legal", "qualified", "qualified-target", "qualified-new"] as const) {
  test(`${driver}: old delivery exception rechecks ${scenario} after SQL success and Git failure`, { skip: driver === "mysql" ? !process.env.GROUNDS_TEST_MYSQL_DATABASE : driver === "postgres" ? !postgresEnabled : false }, async t => {
    const x = await fixture(t, driver); let version = "1";
    if (scenario === "disputed") { await x.verdict("qualified"); await x.verdict("rejected"); }
    else if (scenario === "rejected" || scenario === "inconclusive") await x.verdict(scenario);
    else if (scenario === "selection") { await x.ok(["selection", "clear", "--issue", x.issue, "--issue-version", "2", "--expected-version", "1", "--reason", "测试选择版本漂移"]); await x.ok(["selection", "set", "--issue", x.issue, "--issue-version", "2", "--candidate", x.candidate.candidate_id, "--expected-version", "2", "--reason", "测试重新选择"]); version = "3"; }
    else if (scenario === "source") git(x.cwd, "update-ref", `refs/grounds/candidates/${x.candidate.candidate_id}`, x.base.slice(5));
    if (scenario === "qualified" || scenario === "qualified-target" || scenario === "qualified-new") await x.verdict("qualified");
    if (scenario === "target" || scenario === "qualified-target") { writeFileSync(join(x.cwd, "upstream"), "release\n"); git(x.cwd, "add", "."); git(x.cwd, "commit", "-qm", "release advancement"); git(x.cwd, "push", x.remote, "HEAD:refs/heads/main"); }
    const newOperation = scenario === "qualified-new" ? newUUIDv7() : x.op;
    const retry = await x.materialize(version, newOperation);
    if (scenario === "qualified-new") {
      assert.equal(retry.code, 0, JSON.stringify(retry.envelope)); assert.equal(retry.envelope.data.receipt.delivery_decision_id, undefined);
      assert.equal(await x.f.store.read(tx => tx.getOperation(newOperation)), undefined, "qualified equal preparation must not create an exception or pending operation");
    } else if (scenario === "legal" || scenario === "qualified") {
      assert.equal(retry.code, 0, JSON.stringify(retry.envelope)); assert.equal(retry.envelope.data.receipt.delivery_decision_id, x.op); assert.equal(existsSync(x.target), true);
      await x.verdict("rejected"); const inspect = await x.ok(["selection", "inspect", "--issue", x.issue, "--issue-version", "2", "--path", x.target]); assert.equal(inspect.selection.current_verification.standing, scenario === "qualified" ? "disputed" : "rejected"); assert.ok(inspect.worktrees.length); assert.equal(existsSync(x.target), true); assert.notEqual((await x.materialize()).code, 0);
    } else { assert.notEqual(retry.code, 0, JSON.stringify(retry.envelope)); assert.equal(existsSync(x.target), false); }
    assert.deepEqual(await x.f.store.read(tx => tx.getOperation(x.op)), x.audit, "historical decision audit must remain unchanged");
  });
}
