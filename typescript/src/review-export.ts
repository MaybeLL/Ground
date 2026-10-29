import { timestampOrderKey } from "./sql-shared.js";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { canonicalBytes } from "./canonical-json.js";
import { DomainError } from "./errors.js";
import type { Module, ReviewCandidateOptions } from "./module.js";
import { renderReviewSummaryMarkdownParts, renderReviewVerification, type ReviewSummaryResult, type VerificationPageResult } from "./review.js";

type Entry = VerificationPageResult["verifications"][number];
const timestamp = (value: string): string => value.replace(/\.(\d+)Z$/, (_, fraction: string) => { const trimmed = fraction.replace(/0+$/, ""); return trimmed ? `.${trimmed}Z` : "Z"; });
const digestEntry = (entry: Entry): Buffer => canonicalBytes({ id: entry.verification_id, candidate_id: entry.candidate_id, overall_verdict: entry.overall_verdict, created_at: timestamp(entry.created_at), attribution: entry.attribution });
const corrupt = (): never => { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Verification directory or report does not match the fixed set"); };
const changed = (): never => { throw new DomainError("VERIFICATION_SET_CHANGED", "Verification set changed; restart export", true); };

export class PreparedReviewMarkdown {
  constructor(readonly directory: string, readonly path: string) {}
  async print(write: (line: string) => void | Promise<void>): Promise<void> {
    const stream = createReadStream(this.path, { encoding: "utf8" });
    try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) await write(line); }
    finally { stream.destroy(); this.dispose(); }
  }
  dispose(): void { rmSync(this.directory, { recursive: true, force: true }); }
}

/** Prepare completely before emitting stdout. Only a bounded page/report is held in memory. */
export const prepareReviewMarkdown = async (module: Module, candidateId: string, options: ReviewCandidateOptions = {}, validate?: (summary: ReviewSummaryResult) => void): Promise<PreparedReviewMarkdown> => {
  for (let attempt = 0; ; attempt++) {
    const directory = mkdtempSync(join(tmpdir(), "grounds-review-"));
    const manifest = join(directory, "directory.jsonl");
    const output = join(directory, "review.md");
    try {
      const summary = await module.reviewSummary(candidateId, options);
      validate?.(summary);
      writeFileSync(manifest, "", { mode: 0o600 });
      const hash = createHash("sha256").update("[");
      let count = 0;
      let cursor = "";
      let previous: { key: string; id: string } | undefined;
      const counts = { qualified: 0, rejected: 0, inconclusive: 0 };
      for (;;) {
        const page = await module.verificationPage(candidateId, cursor);
        if (page.candidate_id !== candidateId) corrupt();
        if (page.verification_set.digest !== summary.trace.verification_set.digest) changed();
        if (!canonicalBytes(page.verification_set).equals(canonicalBytes(summary.trace.verification_set))) corrupt();
        for (const entry of page.verifications) {
          const key = timestampOrderKey(entry.created_at);
          if (entry.candidate_id !== candidateId || (previous && (key < previous.key || (key === previous.key && entry.verification_id <= previous.id)))) corrupt();
          if (count++) hash.update(",");
          hash.update(digestEntry(entry));
          counts[entry.overall_verdict as keyof typeof counts]++;
          appendFileSync(manifest, JSON.stringify(entry) + "\n");
          previous = { key, id: entry.verification_id };
        }
        if (!page.next_cursor) break;
        if (!page.verifications.length || page.next_cursor === cursor) corrupt();
        cursor = page.next_cursor;
      }
      const digest = `sha256:${hash.update("]").digest("hex")}`;
      if (count !== summary.trace.verification_set.count || digest !== summary.trace.verification_set.digest || !canonicalBytes(counts).equals(canonicalBytes(summary.trace.verification_set.verdict_counts))) corrupt();
      const parts = renderReviewSummaryMarkdownParts(summary);
      writeFileSync(output, parts.before, { mode: 0o600 });
      const input = createReadStream(manifest, { encoding: "utf8" });
      try {
        for await (const line of createInterface({ input, crlfDelay: Infinity })) {
          const entry = JSON.parse(line) as Entry;
          const report = await module.showVerification(entry.verification_id);
          const actual = { verification_id: report.verification_id, candidate_id: report.candidate_id, overall_verdict: report.overall_verdict, created_at: report.created_at, attribution: report.attribution };
          if (!digestEntry(entry).equals(digestEntry(actual)) || report.report.candidate_id !== candidateId || report.report.result_tree_oid !== summary.trace.artifact.result_tree_oid) corrupt();
          appendFileSync(output, "\n" + renderReviewVerification(summary.trace, { source: "verifier_finding", ...actual, mode: report.mode, report: report.report, ...(report.quality ? { quality: report.quality } : {}) }));
        }
      } finally { input.destroy(); }
      appendFileSync(output, parts.after);
      return new PreparedReviewMarkdown(directory, output);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if (error instanceof DomainError && error.code === "VERIFICATION_SET_CHANGED" && attempt < 2) continue;
      throw error;
    }
  }
};
