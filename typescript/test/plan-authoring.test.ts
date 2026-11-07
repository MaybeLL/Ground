import assert from "node:assert/strict";
import test from "node:test";
import { validateIssueInput } from "../src/domain.js";

test("a whitespace-only plan is rejected rather than silently dropped", () => {
  // v3 requires an explicit failure: a blank section means the author probably
  // meant to write something, and quietly treating it as absent hides that.
  // Structural validation permits incomplete prose, so this gate lives in the
  // domain validator that publication runs.
  const issue = (plan: string) => ({ format: 1, summary: "S", plan, goals: [{ statement: "G", criteria: ["C"] }] });
  // The human-readable reason lives in `details.reason`; `message` is generic.
  const reasonOf = (fn: () => void): string => {
    try { fn(); } catch (error) { return String((error as { details?: { reason?: string } }).details?.reason ?? ""); }
    return "";
  };
  assert.match(reasonOf(() => validateIssueInput(issue("   \n  "))), /whitespace-only/);
  assert.match(reasonOf(() => validateIssueInput(issue(""))), /between 1 and 65536/);
  assert.doesNotThrow(() => validateIssueInput(issue("有内容")));
});

test("plan text may not contain a heading equal to a semantic section name", () => {
  // Such a heading would collide with the authoring parser's section split;
  // plan is non-normative prose, so those names are reserved.
  const issue = (plan: string) => ({ format: 1, summary: "S", plan, goals: [{ statement: "G", criteria: ["C"] }] });
  const reasonOf = (fn: () => void): string => {
    try { fn(); } catch (error) { return String((error as { details?: { reason?: string } }).details?.reason ?? ""); }
    return "";
  };
  for (const name of ["Summary", "Context", "Plan", "Goals", "Constraints", "Open Questions", "Assumptions"]) {
    assert.match(reasonOf(() => validateIssueInput(issue(`说明\n\n## ${name}\n\n正文`))), /reserved section heading/, `## ${name} must be rejected`);
    assert.match(reasonOf(() => validateIssueInput(issue(`# ${name}\n\n正文`))), /reserved section heading/, `# ${name} must be rejected`);
  }
  // Ordinary prose and non-reserved headings are fine.
  assert.doesNotThrow(() => validateIssueInput(issue("## 实现步骤\n\n先加列。\n\n### 细节\n\n再拆定义。")));
});
