import assert from "node:assert/strict";
import test from "node:test";
import { bindDegradedMerge, degradedMergeBindingMatches, evaluateIntegrationGate, evaluateLanding, type GateInput, type LandingInput } from "../src/integration-gate.js";

const gate = (): GateInput => ({
  artifact: { candidate_id: "candidate", base_commit: "base", result_tree_oid: "tree" },
  expected_selection: { id: "selection", version: 3, candidate_id: "candidate" },
  current_selection: { id: "selection", version: 3, candidate_id: "candidate" },
  expected_source: "source",
  source: { oid: "source", parents: ["base"], tree_oid: "tree" },
  target: { oid: "base", relation: "equal" },
  refreshed: true,
});
const expired = (): GateInput => ({ ...gate(), target: { oid: "next", relation: "advanced" } });

test("gate: artifact consistency contains no verification claim", () => {
  assert.deepEqual(evaluateIntegrationGate(gate()), {
    consistency: "ready", checks: { target: "pass", source: "pass", selection: "pass" },
  });
});

test("gate: offline always unknown, keeping each independently evaluated check", () => {
  assert.equal(evaluateIntegrationGate({ ...gate(), refreshed: false }).consistency, "unknown");
  assert.deepEqual(evaluateIntegrationGate({ ...expired(), refreshed: false, current_selection: null }), {
    consistency: "unknown", checks: { target: "fail", source: "pass", selection: "fail" },
  });
});

test("gate: forward advancement is expired only when source and selection both pass", () => {
  assert.equal(evaluateIntegrationGate(expired()).consistency, "expired");
  for (const current_selection of [null, { id: "selection", version: 4, candidate_id: "candidate" }, { id: "selection", version: 3, candidate_id: "other" }]) {
    assert.equal(evaluateIntegrationGate({ ...expired(), current_selection }).consistency, "inconsistent");
  }
  for (const source of [
    { oid: "replaced", parents: ["base"], tree_oid: "tree" },
    { oid: "source", parents: ["next"], tree_oid: "tree" },
    { oid: "source", parents: ["base", "next"], tree_oid: "tree" },
    { oid: "source", parents: [], tree_oid: "tree" },
    { oid: "source", parents: ["base"], tree_oid: "other-tree" },
  ]) assert.equal(evaluateIntegrationGate({ ...expired(), source }).consistency, "inconsistent");
});

test("gate: rewritten, contradictory and incomplete observations fail closed", () => {
  assert.equal(evaluateIntegrationGate({ ...gate(), target: { oid: "rewrite", relation: "rewritten" } }).consistency, "inconsistent");
  assert.equal(evaluateIntegrationGate({ ...gate(), target: { oid: "base", relation: "advanced" } }).consistency, "inconsistent");
  assert.equal(evaluateIntegrationGate({ ...gate(), target: { oid: "other", relation: "equal" } }).consistency, "inconsistent");
  for (const input of [{ ...expired(), source: undefined }, { ...expired(), current_selection: undefined }, { ...gate(), target: undefined }]) {
    assert.equal(evaluateIntegrationGate(input).consistency, "unknown");
  }
  assert.equal(evaluateIntegrationGate({ ...gate(), target: undefined, current_selection: null }).consistency, "inconsistent");
});

test("degraded authorization binds every fact and cannot bypass another failed check", () => {
  const initial = expired();
  const binding = bindDegradedMerge(initial);
  assert.equal(degradedMergeBindingMatches(binding, expired()), true);
  const changes: GateInput[] = [
    gate(), { ...expired(), refreshed: false },
    { ...expired(), target: { oid: "newer", relation: "advanced" } },
    { ...expired(), expected_source: "new-source", source: { oid: "new-source", parents: ["base"], tree_oid: "tree" } },
    { ...expired(), expected_selection: { id: "selection", version: 4, candidate_id: "candidate" }, current_selection: { id: "selection", version: 4, candidate_id: "candidate" } },
    { ...expired(), artifact: { ...initial.artifact, candidate_id: "other" } },
    { ...expired(), source: undefined },
  ];
  for (const change of changes) assert.equal(degradedMergeBindingMatches(binding, change), false);
  for (const input of [gate(), { ...expired(), current_selection: null }, { ...expired(), refreshed: false }]) {
    assert.throws(() => bindDegradedMerge(input), /validation/);
  }
  initial.expected_selection.version = 99;
  assert.equal(binding.selection.version, 3, "binding is not a mutable alias of the observation");
});

const landing = (): LandingInput => ({
  artifact: gate().artifact, expected_source: "source", target_commit: "source",
  provenance: "target_is_source", landed: gate().source, on_first_parent: true,
  has_supported_text_changes: true,
});

test("landing: fast-forward and explicitly supplied squash are eligible for exact text links", () => {
  const result = evaluateLanding(landing());
  assert.equal(result.outcome, "exact_artifact");
  assert.equal(result.delivery_link_commit, "source");
  const squash = evaluateLanding({ ...landing(), provenance: "merge_result", landed: { ...gate().source!, oid: "squash" } });
  assert.equal(squash.delivery_link_commit, "squash");
});

test("landing: identical tree on an advanced base is not exact artifact, no text link", () => {
  const result = evaluateLanding({ ...landing(), provenance: "user", landed: { oid: "degraded", parents: ["next"], tree_oid: "tree" } });
  assert.equal(result.outcome, "same_content_different_base");
  assert.equal(result.tree_matches, true);
  assert.equal(result.parent_matches, false);
  assert.equal(result.delivery_link_commit, undefined);
});

test("landing: non-text-only artifacts never receive a Delivery Link", () => {
  assert.equal(evaluateLanding({ ...landing(), has_supported_text_changes: false }).delivery_link_commit, undefined);
  assert.equal(evaluateLanding({ ...landing(), has_supported_text_changes: false }).outcome, "exact_artifact");
});

test("landing: same parent/tree without provenance does not establish adoption", () => {
  const result = evaluateLanding({ ...landing(), provenance: undefined });
  assert.equal(result.tree_matches, true);
  assert.equal(result.parent_matches, true);
  assert.equal(result.identity, "unknown");
  assert.equal(result.outcome, "adoption_unknown");
  assert.equal(result.delivery_link_commit, undefined);
  assert.equal(evaluateLanding({ ...landing(), target_commit: "other" }).outcome, "adoption_unknown");
});

test("landing: merge second parent is not a single-parent landing; expose actual landing", () => {
  const merge = { oid: "merge", parents: ["next", "source"], tree_oid: "tree" };
  const secondParent = evaluateLanding({ ...landing(), provenance: "user", on_first_parent: false, first_parent_landing: merge });
  assert.equal(secondParent.outcome, "adoption_unknown");
  assert.equal(secondParent.delivery_link_commit, undefined);
  assert.deepEqual(secondParent.first_parent_landing, merge);
  const actual = evaluateLanding({ ...landing(), provenance: "merge_result", landed: merge });
  assert.equal(actual.outcome, "merge_landing");
  assert.equal(actual.tree_matches, true);
  assert.equal(actual.delivery_link_commit, undefined);
});

test("landing: missing commit or different tree is reported without inventing adoption", () => {
  assert.equal(evaluateLanding({ ...landing(), landed: undefined }).outcome, "adoption_unknown");
  assert.equal(evaluateLanding({ ...landing(), landed: { ...gate().source!, tree_oid: "different" } }).outcome, "different_artifact");
});


test("gate: managed archived source accepts checkpoint and merge history while legacy keeps its direct-parent rule", () => {
  const identity = { ...gate(), artifact: { ...gate().artifact, source_commit: "source" }, source_contains_base: true };
  for (const parents of [["checkpoint"], ["checkpoint", "upstream"]]) {
    assert.equal(evaluateIntegrationGate({ ...identity, source: { ...gate().source!, parents } }).consistency, "ready");
    assert.equal(evaluateIntegrationGate({ ...gate(), source: { ...gate().source!, parents } }).consistency, "inconsistent");
  }
  assert.equal(evaluateIntegrationGate(gate()).consistency, "ready");
  assert.equal(evaluateIntegrationGate({ ...identity, source_contains_base: false }).consistency, "inconsistent");
  assert.equal(evaluateIntegrationGate({ ...identity, source_contains_base: undefined }).consistency, "unknown");
  assert.equal(evaluateIntegrationGate({ ...identity, source: { ...gate().source!, oid: "replacement" } }).consistency, "inconsistent");
  assert.equal(evaluateIntegrationGate({ ...identity, source: { ...gate().source!, tree_oid: "replacement-tree" } }).consistency, "inconsistent");
});
