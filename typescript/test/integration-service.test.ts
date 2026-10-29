import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LedgerFixture, testAgent, testVerifier } from "./fixture.js";
import { reviseTargetIssue, seedStartPreflight } from "./preflight-fixture.js";
import { PreflightService } from "../src/preflight.js";
import { newUUIDv7 } from "../src/identity.js";
import { captureArtifact } from "../src/git.js";
import { captureCommittedCandidate } from "../src/development-branch.js";
import { IntegrationService, type AdoptionBinding } from "../src/integration-service.js";
import { assertContract } from "./schema-fixture.js";
import { SQLStore } from "../src/sql-store.js";
import { DatabaseSync } from "node:sqlite";

const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
async function fixture(t: { after: (fn: () => Promise<void>) => void }, modeOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "grounds-integration-service-")), cwd = join(root, "repo"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]); execFileSync("git", ["init", "-b", "main", "-q", cwd]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", "ssh://git@example.test/team/repo");
  git("config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/repo");
  writeFileSync(join(cwd, ".gitignore"), ".grounds/\n"); writeFileSync(join(cwd, "feature"), "old\n");
  git("add", "."); git("commit", "-qm", "base"); const base = `sha1:${git("rev-parse", "HEAD")}`;
  git("push", remote, `${base.slice(5)}:refs/heads/main`);
  const databasePath = join(root, "ledger.db");
  const store = SQLStore.sqlite(databasePath, { busyTimeoutMs: 10 });
  const f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: new PreflightService(store, cwd).coordinator({ refresh: true }) });
  t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); });
  const revised = await reviseTargetIssue(f.module, f.store, cwd, { ...actor(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: base, reachability: "remote_tracking_reachable" }, input: { format: 1, summary: "Target", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "Feature", criteria: ["Feature changes"] }] } });
  await seedStartPreflight(store, { repositoryId: f.repository.repository_id, canonicalRemote: f.repository.canonical_remote, issueId: f.issue.issue_id, issueRevisionId: revised.result.issue_revision_id, target: { remote: "origin", ref: "refs/heads/main" }, commit: base });
  const run = await f.module.startDevRun({ ...actor(), issue_id: f.issue.issue_id, issue_revision_id: revised.result.issue_revision_id, issue_revision_explicit: false, repository_remote_snapshot: f.repository.canonical_remote });
  if (modeOnly) chmodSync(join(cwd, "feature"), 0o755);
  else writeFileSync(join(cwd, "feature"), "candidate\n");
  const { submission } = await f.module.candidateSubmissionTemplate(run.result.context.dev_run.id);
  submission.explanation = "Implemented"; for (const claim of submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Checked"; }
  git("add", "feature"); git("commit", "-qm", "candidate"); const source = `sha1:${git("rev-parse", "HEAD")}`;
  const fixed = captureCommittedCandidate(cwd, base);
  const candidate = await f.module.submitCandidate({ ...f.gitCandidateFields(fixed.artifact, base, fixed.source), ...actor(), dev_run_id: run.result.context.dev_run.id, expected_version: 1, submission, artifact: fixed.artifact });
  git("push", remote, `${source.slice(5)}:refs/heads/feature`);
  const selection = await f.module.setSelection({ ...actor(), issue_id: f.issue.issue_id, issue_version: 2, expected_version: 0, reason: "Explicitly select unverified test artifact", candidate_id: candidate.candidate_id });
  const service = new IntegrationService(f.store, cwd);
  const request = { candidate_id: candidate.candidate_id, selection_id: selection.selection.id!, selection_version: selection.selection.version, source: { remote: "origin", ref: "refs/heads/feature" }, source_commit: source, refresh: true };
  const advance = () => { git("checkout", "--detach", base.slice(5)); writeFileSync(join(cwd, "upstream"), "upstream\n"); git("add", "."); git("commit", "-qm", "upstream"); const oid = `sha1:${git("rev-parse", "HEAD")}`; git("push", remote, `${oid.slice(5)}:refs/heads/main`); return oid; };
  const binding = (landed: string, method: AdoptionBinding["method"]): AdoptionBinding => ({ format: "grounds.adoption-binding/v1", repository_id: f.repository.repository_id, candidate_id: candidate.candidate_id, source_commit: source, landed_commit: landed, target: { remote: "origin", ref: "refs/heads/main" }, method, source: { kind: "user_confirmation", reference: "fixture explicit adoption" } });
  return { f, cwd, git, remote, base, source, service, request, advance, databasePath, binding };
}

test("all integration operation kinds retain their public command identifiers and replay payloads", async t => {
  const x = await fixture(t); x.advance();
  const observeActor = actor(), authorizeActor = actor(), consumeActor = actor(), landingActor = actor();
  const gate = await x.service.observe(x.request, observeActor);
  const reason = "明确接受本次落地风险";
  const authorization = await x.service.authorize(gate.id, reason, authorizeActor);
  assert.deepEqual(await x.service.authorize(gate.id, reason, authorizeActor), authorization);
  const consumed = await x.service.consume(authorization.id, consumeActor);
  await assert.rejects(x.service.consume(authorization.id, consumeActor), { code: "STATE_CONFLICT" });
  const landed = await x.service.landing(gate.id, { refresh: true }, landingActor);
  assert.deepEqual(await x.service.landing(gate.id, { refresh: true }, landingActor), landed);
  assert.deepEqual(await x.service.observe(x.request, observeActor), gate);
  const db = new DatabaseSync(x.databasePath);
  try {
    for (const [who, command, record] of [
      [observeActor, "integration.observe", gate],
      [authorizeActor, "integration.authorize", authorization],
      [consumeActor, "integration.consume", consumed],
      [landingActor, "integration.landing", landed],
    ] as const) {
      const row = db.prepare("SELECT command, result_json FROM idempotency_records WHERE operation_id = ?").get(who.operation_id) as { command: string; result_json: Uint8Array };
      assert.equal(row.command, command);
      const result = JSON.parse(Buffer.from(row.result_json).toString("utf8"));
      assert.equal(result.data.command, command);
      assert.deepEqual(result.data.record, record);
      assertContract("integration.schema.json", result.data);
    }
  } finally { db.close(); }
});

test("refreshed gate persists ready separately from unverified; FF landing gives an exact link candidate", async t => {
  const x = await fixture(t);
  const offline = await x.service.observe({ ...x.request, refresh: false }, actor());
  assert.equal(offline.gate!.decision.consistency, "unknown");
  const who = actor(), gate = await x.service.observe(x.request, who);
  assert.equal(gate.gate!.decision.consistency, "ready");
  assert.equal(gate.gate!.verification.current_verification!.standing, "unverified");
  assert.deepEqual(await x.service.show(gate.id), gate);
  assertContract("integration.schema.json", { result_type: "patchledger.result.integration/v1", command: "integration.show", record: gate });
  assert.deepEqual(await x.service.observe(x.request, who), gate);
  x.git("push", x.remote, `${x.source.slice(5)}:refs/heads/main`);
  const landed = await x.service.landing(gate.id, { refresh: true, adoption: x.binding(x.source, "ff") }, actor());
  assert.equal(landed.landing!.provenance, "target_is_source");
  assert.equal(landed.landing!.decision.outcome, "exact_artifact");
  assert.equal(landed.landing!.decision.delivery_link_commit, x.source);
  assert.equal(landed.landing!.verification.current_verification!.standing, "unverified");
  assert.equal((await x.f.store.inspectIntegrity()).report.valid, true);
});

test("failed refresh never reuses a cached ready observation; replay is checked against the ledger", async t => {
  const x = await fixture(t);
  await x.service.observe(x.request, actor());
  const op = actor(), offline = { ...x.request, refresh: false };
  const cached = await x.service.observe(offline, op);
  assert.equal(cached.gate!.decision.consistency, "unknown");
  assert.deepEqual(cached.gate!.decision.checks, { target: "pass", source: "pass", selection: "pass" });
  renameSync(x.remote, `${x.remote}.saved`);
  try {
    const failed = await x.service.observe(x.request, actor());
    assert.equal(failed.gate!.decision.consistency, "unknown");
    assert.equal(failed.gate!.target_observation.failure, "refresh_failed");
    assert.equal(failed.gate!.input.target, undefined);
    assert.equal(JSON.stringify(failed).includes(x.remote), false);
  } finally { renameSync(`${x.remote}.saved`, x.remote); }
  const db = new DatabaseSync(x.databasePath);
  try {
    const row = db.prepare("SELECT result_json FROM idempotency_records WHERE operation_id = ?").get(op.operation_id) as { result_json: Uint8Array };
    const changed = JSON.parse(Buffer.from(row.result_json).toString("utf8")); changed.data.record.gate.decision.consistency = "ready";
    db.prepare("UPDATE idempotency_records SET result_json = ? WHERE operation_id = ?").run(Buffer.from(JSON.stringify(changed)), op.operation_id);
  } finally { db.close(); }
  await assert.rejects(x.service.observe(offline, op), (error: any) => error.code === "ARTIFACT_INTEGRITY_ERROR");
});

test("degraded authorization refreshes and is consumed once, including concurrent callers", async t => {
  const x = await fixture(t); x.advance();
  const gate = await x.service.observe(x.request, actor());
  assert.equal(gate.gate!.decision.consistency, "expired");
  const authorization = await x.service.authorize(gate.id, "用户明确接受本次落地代码未经验证的风险", actor());
  assert.equal(authorization.disclosure, "landed_code_is_unverified");
  assertContract("integration.schema.json", { result_type: "patchledger.result.integration/v1", command: "integration.show", record: authorization });
  assert.equal(await x.service.authorizationState(authorization.id), "available");
  const otherStore = SQLStore.sqlite(x.databasePath, { busyTimeoutMs: 10 });
  await otherStore.initialize("warn");
  const other = new IntegrationService(otherStore, x.cwd);
  let results;
  try { results = await Promise.allSettled([x.service.consume(authorization.id, actor()), other.consume(authorization.id, actor())]); }
  finally { await otherStore.close(); }
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  for (const result of results) if (result.status === "fulfilled") assertContract("integration.schema.json", { result_type: "patchledger.result.integration/v1", command: "integration.show", record: result.value });
  await assert.rejects(x.service.consume(authorization.id, actor()), { code: "STATE_CONFLICT" });
  assert.equal(await x.service.authorizationState(authorization.id), "consumed");
  const integrity = (await x.f.store.inspectIntegrity()).report;
  assert.equal(integrity.valid, true, JSON.stringify(integrity));
});

test("source or Selection changes cannot be waived by target advancement", async t => {
  const x = await fixture(t); x.advance();
  const gate = await x.service.observe(x.request, actor());
  const authorization = await x.service.authorize(gate.id, "本次明确接受风险", actor());
  await x.f.module.setSelection({ ...actor(), issue_id: x.f.issue.issue_id, issue_version: 2, expected_version: 1, reason: "Explicit test re-selection", candidate_id: x.request.candidate_id });
  const changed = await x.service.observe(x.request, actor());
  assert.equal(changed.gate!.decision.consistency, "inconsistent");
  await assert.rejects(x.service.authorize(changed.id, "不能覆盖其他失败", actor()));
  await assert.rejects(x.service.consume(authorization.id, actor()), { code: "STATE_CONFLICT" });
  const unknown = await x.service.landing(gate.id, { refresh: true }, actor());
  assert.equal(unknown.landing!.decision.outcome, "adoption_unknown");
});

test("a replaced source is inconsistent even when target advanced, and a lookalike does not prove adoption", async t => {
  const x = await fixture(t); x.advance();
  const expired = await x.service.observe(x.request, actor());
  const authorization = await x.service.authorize(expired.id, "本次明确接受风险", actor());
  x.git("checkout", "--detach", x.source.slice(5)); x.git("commit", "--allow-empty", "-qm", "source changed");
  x.git("push", x.remote, "HEAD:refs/heads/feature");
  const changed = await x.service.observe(x.request, actor());
  assert.equal(changed.gate!.decision.consistency, "inconsistent");
  assert.equal(changed.gate!.decision.checks.source, "fail");
  assert.equal(changed.gate!.decision.checks.selection, "pass");
  await assert.rejects(x.service.consume(authorization.id, actor()));
  assert.equal(await x.service.authorizationState(authorization.id), "available");
  const y = await fixture(t), gate = await y.service.observe(y.request, actor());
  const lookalike = y.git("commit-tree", y.git("rev-parse", `${y.source.slice(5)}^{tree}`), "-p", y.base.slice(5), "-m", "independent same-parent same-tree commit");
  y.git("push", y.remote, `${lookalike}:refs/heads/main`);
  const unknown = await y.service.landing(gate.id, { refresh: true }, actor());
  assert.equal(unknown.landing!.decision.outcome, "adoption_unknown");
  assert.equal(unknown.landing!.supplied_commit, undefined);
});

test("new rejection changes Verification standing, never artifact consistency", async t => {
  const x = await fixture(t);
  const blind = (await x.f.module.verificationContext(x.request.candidate_id, "blind")).context;
  assert.ok(blind.phase === "blind");
  const goal = blind.issue.goals[0]!;
  await x.f.module.submitVerification({ operation_id: newUUIDv7(), attribution: testVerifier, report: {
    format: "patchledger.verification-report/v1", candidate_id: x.request.candidate_id, result_tree_oid: blind.result_tree_oid, blind_context_digest: blind.blind_context_digest,
    assessments: [{ target_type: "goal", target_id: goal.id, criteria: [{ criterion_id: goal.criteria[0]!.id,
      independent: { verdict: "rejected", explanation: "Synthetic regression finding", evidence: [] }, reconciliation: { claim_relation: "contradicted", explanation: "Synthetic comparison" }, final: { verdict: "rejected", explanation: "Synthetic failure" } }] }],
  } });
  const gate = await x.service.observe(x.request, actor());
  assert.equal(gate.gate!.decision.consistency, "ready");
  assert.equal(gate.gate!.verification.current_verification.standing, "rejected");
  assert.equal(gate.gate!.verification.verification_changed, true);
});

test("second-parent source reports the actual merge entry, not an exact single-parent landing", async t => {
  const x = await fixture(t); x.advance();
  const gate = await x.service.observe(x.request, actor());
  x.git("merge", "--no-ff", "--no-edit", x.source.slice(5));
  const merge = `sha1:${x.git("rev-parse", "HEAD")}`;
  x.git("push", x.remote, `${merge.slice(5)}:refs/heads/main`);
  const second = await x.service.landing(gate.id, { commit: x.source, provenance: "user", refresh: true }, actor());
  assert.equal(second.landing!.decision.outcome, "adoption_unknown");
  assert.equal(second.landing!.decision.first_parent_landing!.oid, merge);
  const landed = await x.service.landing(gate.id, { commit: merge, provenance: "user", refresh: true, adoption: x.binding(merge, "merge") }, actor());
  assert.equal(landed.landing!.decision.outcome, "different_artifact");
  assert.equal(landed.landing!.decision.delivery_link_commit, undefined);
});

test("same contents on a different base and non-text exact artifacts never offer a Delivery Link", async t => {
  const x = await fixture(t);
  x.git("checkout", "--detach", x.base.slice(5)); x.git("commit", "--allow-empty", "-qm", "advance without changing content");
  x.git("push", x.remote, "HEAD:refs/heads/main");
  const gate = await x.service.observe(x.request, actor());
  assert.equal(gate.gate!.decision.consistency, "expired");
  x.git("read-tree", "--reset", "-u", x.source.slice(5)); x.git("commit", "-qm", "same contents, different base");
  const landedOid = `sha1:${x.git("rev-parse", "HEAD")}`; x.git("push", x.remote, "HEAD:refs/heads/main");
  const landed = await x.service.landing(gate.id, { commit: landedOid, provenance: "user", refresh: true, adoption: x.binding(landedOid, "squash") }, actor());
  assert.equal(landed.landing!.decision.outcome, "same_content_different_history");
  assert.equal(landed.landing!.decision.delivery_link_commit, undefined);
  const y = await fixture(t, true), modeGate = await y.service.observe(y.request, actor());
  y.git("push", y.remote, `${y.source.slice(5)}:refs/heads/main`);
  const mode = await y.service.landing(modeGate.id, { refresh: true, adoption: y.binding(y.source, "ff") }, actor());
  assert.equal(mode.landing!.decision.outcome, "exact_artifact");
  assert.equal(mode.landing!.delivery_link_eligibility, "no_supported_text_changes");
  assert.equal(mode.landing!.decision.delivery_link_commit, undefined);
});
