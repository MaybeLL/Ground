import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdownPreview } from "../src/markdown-preview.js";

const size = (lines: string[]): { characters: number; lines: number } => {
  const text = lines.join("\n") + "\n\n";
  return { characters: [...text].length, lines: text.split("\n").length };
};

test("preview includes an exact-fit Unicode block but never cuts it at a smaller budget", () => {
  const intro = Object.freeze(["# Review", "Warning: disputed"]);
  const section = { header: ["## Changes"], blocks: [["- `界😀` — reason"]], total: 1, label: "records" };
  const before = structuredClone(section);
  const full = renderMarkdownPreview(intro, [section]);
  const exact = size(full);
  assert.deepEqual(renderMarkdownPreview(intro, [section], exact), full);
  const reduced = renderMarkdownPreview(intro, [section], { ...exact, characters: exact.characters - 1 });
  assert.ok(!reduced.some((line) => line.includes("界")));
  assert.equal(reduced.at(-1), "Remaining in details: 1 records.");
  assert.deepEqual(section, before);
});

test("line budget includes embedded newlines, headings and the details separator", () => {
  const sections = [{ header: ["## Changes"], blocks: [["- first\n  continued"]], total: 1, label: "records" }];
  const full = renderMarkdownPreview(["# Review"], sections);
  const exact = size(full);
  assert.deepEqual(renderMarkdownPreview(["# Review"], sections, exact), full);
  const result = renderMarkdownPreview(["# Review"], sections, { ...exact, lines: exact.lines - 1 });
  assert.ok(!result.join("\n").includes("first"));
  assert.ok(size(result).lines <= exact.lines - 1);
});

test("required late sections survive oversized earlier previews and counts remain exact", () => {
  const sections = [
    { header: ["## Paths"], blocks: [["x".repeat(4000)], ["must not skip the first path"]], total: 100, label: "paths" },
    { header: ["## Intent", "Unknown intent"], blocks: [], total: 0, label: "intent groups" },
    { header: ["## Changes"], blocks: [["- Recorded reason"]], total: 9, label: "rationale records" },
  ];
  const result = renderMarkdownPreview(["# Review", "Warning: unverified"], sections);
  assert.ok(result.includes("Unknown intent"));
  assert.ok(result.includes("- Recorded reason"));
  assert.ok(!result.includes("must not skip the first path"));
  assert.equal(result.at(-1), "Remaining in details: 100 paths; 0 intent groups; 8 rationale records.");
  assert.ok(size(result).characters <= 4000);
});

test("an impossible mandatory budget fails explicitly instead of dropping review warnings", () => {
  assert.throws(() => renderMarkdownPreview(["Warning: disputed"], [], { characters: 1, lines: 1 }), RangeError);
});
