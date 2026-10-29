import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSafeYAML, safeYAMLToJS } from "../src/yaml-safe.js";
import { decodeEvalJSON } from "../src/evaluation.js";

const parse = (text: string, options?: { allowNulls?: boolean }) =>
  parseSafeYAML(Buffer.from(text), "file", options);
const toJS = <T>(text: string, options?: { allowNulls?: boolean }) =>
  safeYAMLToJS<T>(Buffer.from(text), "file", options);

/** Validation errors carry their reason in `details`, not in `message`. */
const rejection = (text: string, run: (t: string) => unknown = (t) => parse(t)) => {
  try {
    run(text);
  } catch (error) {
    const details = (error as { details?: { field?: unknown; reason?: unknown } }).details;
    assert.ok(details, "expected a validation error carrying details");
    return { field: String(details.field), reason: String(details.reason) };
  }
  throw new Error("expected the document to be rejected");
};

test("null stays illegal by default so the input model keeps its safeguard", () => {
  assert.match(rejection("usage: null\n").reason, /YAML null is not supported/);
  assert.match(rejection("usage:\n").reason, /YAML null is not supported/);
  assert.match(rejection("items:\n  - null\n").reason, /YAML null is not supported/);
});

test("the eval JSON null safeguard is unchanged by default", () => {
  // Recorded deliberately by the existing input-model test.
  assert.throws(() => decodeEvalJSON(Buffer.from('{"name":null}')));
  assert.throws(() => decodeEvalJSON(Buffer.from('{"name":null,}')));
});

test("allowNulls accepts a null so stored evidence re-reads", () => {
  // Evaluation captures record `metrics.usage: null` when a session errored and
  // reported no token usage. eval.schema.json allows exactly that
  // (environmentMetrics.usage -> anyOf [null, object]), so a stored null must
  // survive the round trip.
  assert.deepEqual(toJS("usage: null\n", { allowNulls: true }), { usage: null });
  assert.deepEqual(toJS("a:\n  b: null\n", { allowNulls: true }), { a: { b: null } });
  assert.deepEqual(toJS("items:\n  - null\n  - 1\n", { allowNulls: true }), { items: [null, 1] });
});

test("allowNulls accepts an empty value as null and keeps its mapping key", () => {
  assert.deepEqual(toJS("usage:\n", { allowNulls: true }), { usage: null });
  assert.deepEqual(toJS("a: 1\nusage:\n", { allowNulls: true }), { a: 1, usage: null });
});

test("allowNulls accepts null inside a sequence of mappings", () => {
  assert.deepEqual(toJS("rows:\n  - usage: null\n    source: codex\n", { allowNulls: true }), {
    rows: [{ usage: null, source: "codex" }],
  });
});

test("evidence JSON carrying a null usage decodes under the nullable contract", () => {
  const bytes = Buffer.from('{"metrics":{"duration_ms":1,"source":"codex.turn.completed","usage":null}}');
  assert.deepEqual(decodeEvalJSON(bytes, { allowNulls: true }), {
    metrics: { duration_ms: 1, source: "codex.turn.completed", usage: null },
  });
  // The same document stays rejected under the default contract.
  assert.throws(() => decodeEvalJSON(bytes));
});

test("null never names a field, even with allowNulls", () => {
  const { field, reason } = rejection("null: 1\n", (t) => parse(t, { allowNulls: true }));
  assert.equal(field, "file.key[0]");
  assert.match(reason, /mapping keys must be strings/);
});

test("the other dialect restrictions are unchanged, with or without allowNulls", () => {
  for (const options of [undefined, { allowNulls: true }]) {
    assert.match(rejection("a: &x 1\nb: *x\n", (t) => parse(t, options)).reason, /anchors are not supported/);
    assert.match(rejection("a: !!binary aGk=\n", (t) => parse(t, options)).reason, /custom YAML tags are not supported/);
    assert.match(rejection("b: 1\na: 2\nb: 3\n", (t) => parse(t, options)).reason, /unique/i);
  }
});
