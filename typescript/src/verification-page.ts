import type { Attribution } from "./domain.js";

export interface VerificationSetSummary {
  source: "derived_relation";
  count: number;
  digest: string;
  standing: string;
  verdict_counts: { qualified: number; rejected: number; inconclusive: number };
  reports_included: false;
}

export interface VerificationPageResult {
  result_type: "patchledger.result.verification-page/v1";
  command: "verification.list";
  candidate_id: string;
  verification_set: VerificationSetSummary;
  verifications: { verification_id: string; candidate_id: string; overall_verdict: string; created_at: string; attribution: Attribution }[];
  next_cursor?: string;
}
