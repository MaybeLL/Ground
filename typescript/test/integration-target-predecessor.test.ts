import { PreflightService } from "../src/preflight.js";
import { reviseTargetIssue, seedStartPreflight, seedRunAdmission } from "./preflight-fixture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LedgerFixture, testAgent } from "./fixture.js";
import { IntegrationService, type AdoptionBinding, type IntegrationRecord } from "../src/integration-service.js";
import { captureCommittedArtifact, resolveBaseline } from "../src/git.js";
import { readCommit } from "../src/integration-history.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import { sha256 } from "../src/canonical-json.js";
const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(cwd: string, file: string) { writeFileSync(join(cwd, file), file + "\n"); git(cwd, "add", "-A"); git(cwd, "commit", "-qm", file); return resolveBaseline(cwd, "HEAD"); }
async function fixture(t: { after(fn: () => Promise<void>): void }, sidePredecessor = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-predecessor-"))), cwd = join(root, "repo"), remote = join(root, "remote.git");
  git(root, "init", "--bare", "-q", remote); git(root, "init", "-qb", "main", cwd); git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "remote", "add", "origin", "ssh://git@example.test/team/repo"); git(cwd, "config", `url.file://${remote}.insteadOf`, "ssh://git@example.test/team/repo"); writeFileSync(join(cwd, ".gitignore"), ".grounds/\n");
  const base = commit(cwd, "base"); git(cwd, "push", remote, "HEAD:refs/heads/main");
  git(cwd, "checkout", "-qb", "feature"); const intermediate = commit(cwd, "feature-one");
  let predecessor = base;
  if (sidePredecessor) {
    git(cwd, "checkout", "main"); predecessor = commit(cwd, "upstream"); git(cwd, "checkout", "feature"); git(cwd, "merge", "--no-ff", "main", "-m", "integrate upstream side parent");
  }
  const source = commit(cwd, "feature-two"), identity = readCommit(cwd, source); git(cwd, "push", remote, "HEAD:refs/heads/feature");
  const store = SQLStore.sqlite(join(root, "ledger.db")), f = await LedgerFixture.createWithStore(store, () => store.close(), { preflightCoordinator: new PreflightService(store, cwd).coordinator({ refresh: true }) }); t.after(async () => { await f.close(); rmSync(root, { recursive: true, force: true }); });
  const revised = await reviseTargetIssue(f.module, store, cwd, { ...actor(), issue_id: f.issue.issue_id, expected_predecessor_id: f.issue.issue_revision_id, requirement_revision_id: f.requirement.requirement_revision_id, requirement_revision_explicit: true, baseline: { git_oid: base, reachability: "remote_tracking_reachable" }, input: { format: 1, summary: "Predecessor identity", target_branch: { remote: "origin", ref: "refs/heads/main" }, goals: [{ statement: "Feature", criteria: ["Both feature files are delivered"] }] } });
  await seedStartPreflight(store, { repositoryId: f.repository.repository_id, canonicalRemote: f.repository.canonical_remote, issueId: f.issue.issue_id, issueRevisionId: revised.result.issue_revision_id, target: { remote: "origin", ref: "refs/heads/main" }, commit: base });
  const workspaceId = newUUIDv7();
  const run = await f.module.startDevRun({ ...actor(), issue_id: f.issue.issue_id, issue_revision_id: revised.result.issue_revision_id, issue_revision_explicit: true, repository_remote_snapshot: f.repository.canonical_remote, development: { format: "grounds.development-branch/v1", workspace_id: workspaceId, branch: `grounds/predecessor-fixture/${workspaceId}` } });
  await seedRunAdmission(store, { devRunId: run.result.context.dev_run.id });
  const artifact = captureCommittedArtifact(cwd, base, source), template = await f.module.candidateSubmissionTemplate(run.result.context.dev_run.id, artifact);
  template.submission.explanation = "Implement both feature files";
  for (const claim of template.submission.claims) { claim.explanation = "Implemented"; for (const criterion of claim.criteria) criterion.explanation = "Both files exist"; }
  if (template.submission.format === "patchledger.candidate-submission/v2") for (const rationale of template.submission.change_rationales) { rationale.rationale = "Implement the fixed feature criterion"; rationale.target_refs = [{ type: "criterion", id: template.submission.claims[0]!.criteria[0]!.criterion_id }]; }
  const candidate = await f.module.submitCandidate({ ...actor(), dev_run_id: run.result.context.dev_run.id, expected_version: 1, artifact, ...f.gitCandidateFields(artifact, base, { commit: source, parents: identity.parents }), source: { commit: source, parents: identity.parents }, submission: template.submission });
  const selected = await f.module.setSelection({ ...actor(), issue_id: f.issue.issue_id, issue_version: 2, expected_version: 0, candidate_id: candidate.candidate_id, reason: "Select unverified fixture" });
  const service = new IntegrationService(store, cwd);
  const gate = await service.observe({ candidate_id: candidate.candidate_id, selection_id: selected.selection.id!, selection_version: selected.selection.version, source: { remote: "origin", ref: "refs/heads/feature" }, source_commit: source, refresh: true }, actor());
  assert.equal(gate.gate!.input.target!.oid, base);
  const binding = (landed: string, method: AdoptionBinding["method"], p?: string): AdoptionBinding => ({ format: "grounds.adoption-binding/v1", repository_id: f.repository.repository_id, candidate_id: candidate.candidate_id, source_commit: source, landed_commit: landed, target: { remote: "origin", ref: "refs/heads/main" }, method, ...(p ? { target_predecessor: p } : {}), source: { kind: "user_confirmation", reference: "Explicit controlled target ref transition" } });
  const land = async (method: AdoptionBinding["method"]) => {
    git(cwd, "checkout", "main");
    if (sidePredecessor) git(cwd, "push", remote, "HEAD:refs/heads/main");
    if (method === "ff") git(cwd, "merge", "--ff-only", "feature");
    else if (method === "merge") git(cwd, "merge", "--no-ff", "feature", "-m", "actual target merge");
    else { git(cwd, "merge", "--squash", "feature"); git(cwd, "commit", "-qm", "actual target squash"); }
    const landed = resolveBaseline(cwd, "HEAD"); git(cwd, "push", remote, "HEAD:refs/heads/main"); return landed;
  };
  return { root, cwd, remote, base, predecessor, source, intermediate, f, service, gate, candidate, binding, land };
}

test("multi-commit FF uses explicit target transition P, covering the whole delivered change", async t => {
  const x = await fixture(t), landed = await x.land("ff"), who = actor(), options = { commit: landed, provenance: "user" as const, refresh: true, adoption: x.binding(landed, "ff", x.base) };
  const result = await x.service.landing(x.gate.id, options, who);
  assert.equal(result.landing!.decision.identity, "trusted"); assert.equal(result.landing!.actual_landing!.oid, landed);
  assert.deepEqual(result.landing!.target_predecessor, { state: "confirmed", source: "adoption_binding", commit: readCommit(x.cwd, x.base) });
  assert.notEqual(result.landing!.actual_landing!.parents[0], x.base);
  const changes = git(x.cwd, "diff", "--name-only", x.base.slice(5), landed.slice(5)); assert.match(changes, /feature-one/); assert.match(changes, /feature-two/);
  assert.deepEqual(await x.service.landing(x.gate.id, options, who), result);
  await assert.rejects(x.service.landing(x.gate.id, { ...options, adoption: { ...options.adoption, target_predecessor: x.intermediate } }, who), { code: "IDEMPOTENCY_CONFLICT" });
});

test("FF predecessor may differ from gate T and be retained only through a second-parent path", async t => {
  const x = await fixture(t, true), landed = await x.land("ff");
  assert.notEqual(x.predecessor, x.gate.gate!.input.target!.oid); assert.equal(git(x.cwd, "rev-list", "--first-parent", landed.slice(5)).split("\n").includes(x.predecessor.slice(5)), false);
  const result = await x.service.landing(x.gate.id, { commit: landed, provenance: "user", refresh: true, adoption: x.binding(landed, "ff", x.predecessor) }, actor());
  assert.equal(result.landing!.decision.identity, "trusted"); assert.equal(result.landing!.target_predecessor!.state, "confirmed"); assert.equal(result.landing!.target_predecessor!.commit!.oid, x.predecessor);
  const patch = git(x.cwd, "diff", "--name-only", x.predecessor.slice(5), landed.slice(5)); assert.match(patch, /feature-one/); assert.match(patch, /feature-two/); assert.doesNotMatch(patch, /upstream/);
});

test("missing, unavailable or unrelated FF predecessor preserves trusted adoption without inventing P", async t => {
  const x = await fixture(t), landed = await x.land("ff");
  const unrelated = `sha1:${git(x.cwd, "commit-tree", git(x.cwd, "rev-parse", "HEAD^{tree}"), "-m", "unrelated root")}`;
  for (const [predecessor, expected] of [[undefined, "unknown"], [`sha1:${"f".repeat(40)}`, "unknown"], [unrelated, "conflict"], [landed, "conflict"]] as const) {
    const result = await x.service.landing(x.gate.id, { commit: landed, provenance: "user", refresh: true, adoption: x.binding(landed, "ff", predecessor) }, actor());
    assert.equal(result.landing!.decision.identity, "trusted"); assert.equal(result.landing!.actual_landing!.oid, landed); assert.equal(result.landing!.target_predecessor!.state, expected); assert.equal(result.landing!.target_predecessor!.commit, undefined);
  }
});

for (const method of ["merge", "squash"] as const) test(`${method} derives actual first-parent P and reports conflicting explicit evidence independently`, async t => {
  const x = await fixture(t), landed = await x.land(method);
  const inferred = await x.service.landing(x.gate.id, { commit: landed, provenance: "user", refresh: true, adoption: x.binding(landed, method) }, actor());
  assert.equal(inferred.landing!.decision.identity, "trusted"); assert.deepEqual(inferred.landing!.target_predecessor, { state: "confirmed", source: "landing_first_parent", commit: readCommit(x.cwd, x.base) });
  const wrong = await x.service.landing(x.gate.id, { commit: landed, provenance: "user", refresh: true, adoption: x.binding(landed, method, x.intermediate) }, actor());
  assert.equal(wrong.landing!.decision.identity, "trusted"); assert.equal(wrong.landing!.actual_landing!.oid, landed); assert.equal(wrong.landing!.target_predecessor!.state, "conflict");
  const explicit = await x.service.landing(x.gate.id, { commit: landed, provenance: "merge_result", refresh: true, adoption: { ...x.binding(landed, method, x.base), source: { kind: "merged_mr", reference: "Supplied actual target merge update result" } } }, actor());
  assert.equal(explicit.landing!.target_predecessor!.state, "confirmed"); assert.equal(explicit.landing!.target_predecessor!.source, "adoption_binding");
});

test("legacy landing records keep original raw facts and replay; supplemental P is a new observation", async t => {
  const x = await fixture(t), landed = await x.land("ff"), options = { commit: landed, provenance: "user" as const, refresh: true, adoption: x.binding(landed, "ff") };
  const recent = await x.service.landing(x.gate.id, options, actor()), who = actor();
  const legacy: IntegrationRecord = structuredClone(recent); legacy.id = newUUIDv7(); delete legacy.landing!.target_predecessor;
  await x.f.store.write(async tx => {
    await tx.reserveOperation({ id: who.operation_id, command: "integration.landing", request_hash: sha256(JSON.parse(JSON.stringify({ request: { observationId: x.gate.id, options }, attribution: who.attribution }))) });
    await tx.appendLedgerEvent({ event_id: legacy.id, event_type: "integration.landing", event_version: 1, operation_id: who.operation_id, repository_id: x.f.repository.repository_id, subject_type: "candidate", subject_id: x.candidate.candidate_id, occurred_at: legacy.created_at, attribution: who.attribution, facts: [{ name: "record", value: JSON.stringify(legacy) }, { name: "record_digest", value: sha256(legacy) }] });
    await tx.completeOperation(who.operation_id, JSON.stringify({ format: "patchledger.cli/v1", ok: true, operation_id: who.operation_id, data: { result_type: "patchledger.result.integration/v1", command: "integration.landing", record: legacy }, warnings: [] }));
  });
  const raw = await x.f.store.read(tx => tx.getLedgerEvent(legacy.id));
  assert.deepEqual(await x.service.show(legacy.id), legacy); assert.deepEqual(await x.service.landing(x.gate.id, options, who), legacy);
  const supplied = { ...options, adoption: { ...options.adoption, target_predecessor: x.base, source: { kind: "user_confirmation" as const, reference: "Additional explicit before/after target update evidence" } } };
  await assert.rejects(x.service.landing(x.gate.id, supplied, who), { code: "IDEMPOTENCY_CONFLICT" });
  const observation = await x.service.landing(x.gate.id, supplied, actor()); assert.notEqual(observation.id, legacy.id); assert.equal(observation.landing!.target_predecessor!.commit!.oid, x.base);
  assert.deepEqual(await x.f.store.read(tx => tx.getLedgerEvent(legacy.id)), raw); assert.equal((await x.service.show(legacy.id)).landing!.target_predecessor, undefined);
});

test("missing predecessor closure blobs remain unknown while trusted landing facts survive", async t => {
  const x = await fixture(t), landed = await x.land("ff");
  const blob = git(x.cwd, "rev-parse", `${x.base.slice(5)}:base`);
  const objects = git(x.cwd, "rev-parse", "--path-format=absolute", "--git-path", "objects");
  rmSync(join(objects, blob.slice(0, 2), blob.slice(2)));
  const result = await x.service.landing(x.gate.id, { commit: landed, provenance: "user", refresh: true, adoption: x.binding(landed, "ff", x.base) }, actor());
  assert.equal(result.landing!.decision.identity, "trusted"); assert.equal(result.landing!.actual_landing!.oid, landed);
  assert.equal(result.landing!.target_predecessor!.state, "unknown"); assert.equal(result.landing!.target_predecessor!.commit, undefined);
  assert.equal(result.landing!.target_predecessor!.reason, "target_predecessor_objects_or_history_unavailable");
});
