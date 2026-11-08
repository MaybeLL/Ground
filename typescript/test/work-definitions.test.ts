import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, createDefinition, digestOf, isRevisionRef, parseGraderContent, parseTaskContent, publishRevision, refOf, resolveEnvironment, sameRef, type Definition, type DefinitionKind, type JsonValue } from "../src/work/domain/index.js";
import { accept, clock, hash, ids, rejected } from "./work-fixtures.js";

const at = clock();
const task = { kind: "coding", schemaVersion: 1, summary: "Add export", criteria: [{ id: "c1", statement: "exports CSV" }] };

function define(kind: DefinitionKind, id = "def-1"): Definition {
  return accept(createDefinition({ id, kind, name: `${kind} definition`, at: at() })).state;
}

test("canonical JSON is independent of key order and rejects values with no stable form", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, { d: "x", c: 2 }] }), canonicalJson({ a: [true, null, { c: 2, d: "x" }], b: 1 }));
  assert.throws(() => canonicalJson(Number.NaN));
  rejected(digestOf({ a: Number.POSITIVE_INFINITY }, hash), "invalid");
  rejected(digestOf({ a: 1 }, () => "short"), "invalid", /hasher/);
});

test("a definition starts at revision zero and publishes numbered, linked, immutable revisions", () => {
  const next = ids("rev");
  const created = define("task");
  assert.equal(created.head.seq, 0);
  const first = accept(publishRevision(created, { revisionId: next(), expectedSeq: 0, content: task, at: at() }, hash));
  assert.equal(first.outcome.seq, 1);
  assert.equal(first.outcome.predecessorId, undefined);
  assert.equal(first.state.version, created.version + 1);
  const changed = { ...task, summary: "Add export v2" };
  const second = accept(publishRevision(first.state, { revisionId: next(), expectedSeq: 1, content: changed, at: at() }, hash));
  assert.equal(second.outcome.seq, 2);
  assert.equal(second.outcome.predecessorId, first.outcome.id);
  assert.notEqual(second.outcome.digest, first.outcome.digest);
  assert.equal(first.outcome.content, task, "publishing a successor leaves the earlier revision untouched");
});

test("publishing needs the revision the publisher saw as latest", () => {
  const base = define("task");
  const first = accept(publishRevision(base, { revisionId: "r1", expectedSeq: 0, content: task, at: at() }, hash));
  rejected(publishRevision(first.state, { revisionId: "r2", expectedSeq: 0, content: { ...task, summary: "x" }, at: at() }, hash), "conflict", /revision 1/);
  rejected(publishRevision(first.state, { revisionId: "r2", expectedSeq: 1, content: task, at: at() }, hash), "conflict", /unchanged/);
});

test("revision references name an exact revision", () => {
  const base = define("task");
  const revision = accept(publishRevision(base, { revisionId: "r1", expectedSeq: 0, content: task, at: at() }, hash)).outcome;
  const ref = refOf(revision);
  assert.ok(isRevisionRef(ref, "task"));
  assert.ok(!isRevisionRef(ref, "agent"));
  assert.ok(!isRevisionRef({ ...ref, digest: "sha256:zz" }));
  assert.ok(sameRef(ref, refOf(revision)));
  assert.ok(!sameRef(ref, { ...ref, digest: `sha256:${"0".repeat(64)}` }));
});

test("task content is validated, including unique criteria", () => {
  assert.ok(parseTaskContent(task).ok);
  rejected(parseTaskContent({ ...task, kind: "other" }), "invalid", /kind/);
  rejected(parseTaskContent({ ...task, criteria: [{ id: "c1", statement: "a" }, { id: "c1", statement: "b" }] }), "invalid", /unique/);
  rejected(parseTaskContent({ ...task, summary: "" }), "invalid");
  rejected(parseTaskContent("text"), "invalid");
  const publishing = publishRevision(define("task"), { revisionId: "r1", expectedSeq: 0, content: { kind: "coding" } as JsonValue, at: at() }, hash);
  rejected(publishing, "invalid");
});

test("grader content fixes its scale and, for test graders, the environment revision", () => {
  const numeric = { strategy: "agent", scale: { form: "numeric", min: 0, max: 5 } };
  assert.ok(parseGraderContent(numeric).ok);
  assert.ok(parseGraderContent({ strategy: "rule", scale: { form: "category", categories: ["pass", "fail"] } }).ok);
  assert.ok(parseGraderContent({ strategy: "test", scale: { form: "criteria" }, environmentRevisionId: "env-rev-1" }).ok);
  rejected(parseGraderContent({ strategy: "test", scale: { form: "criteria" } }), "invalid", /environment/);
  rejected(parseGraderContent({ strategy: "rule", scale: { form: "criteria" }, environmentRevisionId: "e" }), "invalid", /no environment/);
  rejected(parseGraderContent({ strategy: "agent", scale: { form: "numeric", min: 5, max: 5 } }), "invalid", /min < max/);
  rejected(parseGraderContent({ strategy: "agent", scale: { form: "category", categories: ["a", "a"] } }), "invalid");
  rejected(parseGraderContent({ strategy: "agent", scale: { form: "weird" } }), "invalid");
});

test("other kinds need their minimum content", () => {
  rejected(publishRevision(define("agent"), { revisionId: "r1", expectedSeq: 0, content: {}, at: at() }, hash), "invalid");
  rejected(publishRevision(define("agent"), { revisionId: "r1", expectedSeq: 0, content: { model: "m" }, at: at() }, hash), "invalid", /provider/);
  accept(publishRevision(define("agent"), { revisionId: "r1", expectedSeq: 0, content: { provider: "claude-cli" }, at: at() }, hash));
  rejected(publishRevision(define("suite"), { revisionId: "r1", expectedSeq: 0, content: { cases: [{ key: "a" }, { key: "a" }] }, at: at() }, hash), "invalid", /unique/);
  accept(publishRevision(define("suite"), { revisionId: "r1", expectedSeq: 0, content: { cases: [{ key: "a" }, { key: "b" }] }, at: at() }, hash));
});

test("a resolved environment must belong to the definition the task requires", () => {
  const parsed = parseTaskContent({ ...task, environmentDefinitionId: "env-def" });
  assert.ok(parsed.ok);
  const content = parsed.value;
  const environment = { kind: "environment" as const, definitionId: "env-def", revisionId: "env-rev-2", seq: 2, digest: `sha256:${"a".repeat(64)}` };
  const resolved = resolveEnvironment(content, environment, "latest");
  assert.ok(resolved.ok);
  assert.equal(resolved.value.source, "latest");
  assert.equal(resolved.value.revision.revisionId, "env-rev-2");
  rejected(resolveEnvironment(content, { ...environment, definitionId: "other" }, "specified"), "conflict", /does not belong/);
  rejected(resolveEnvironment(content, { ...environment, kind: "agent" }, "specified"), "invalid");
  const { environmentDefinitionId: _unused, ...withoutEnvironment } = content;
  rejected(resolveEnvironment(withoutEnvironment, environment, "latest"), "conflict", /no environment/);
});
