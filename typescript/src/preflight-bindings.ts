import { sha256 } from "./canonical-json.js";

export interface PublishBinding {
  canonical_remote?: string;
  requirement?: {
    requirement_id?: string;
    requirement_revision_id?: string;
    predecessor_revision_id?: string;
    require_current?: boolean;
    content?: unknown;
  };
  issues: {
    issue_id?: string;
    predecessor_revision_id?: string;
    requirement_revision_id?: string;
    baseline_oid?: string;
    target_branch?: unknown;
    input: unknown;
  }[];
}

export const contentDigestFor = (binding: PublishBinding): string => sha256({
  canonical_remote: binding.canonical_remote ?? null,
  requirement: binding.requirement ? {
    requirement_id: binding.requirement.requirement_id ?? null,
    requirement_revision_id: binding.requirement.requirement_revision_id ?? null,
    predecessor_revision_id: binding.requirement.predecessor_revision_id ?? null,
    require_current: binding.requirement.require_current ?? true,
    content: binding.requirement.content ?? null,
  } : null,
  issues: binding.issues.map(issue => ({
    issue_id: issue.issue_id ?? null,
    predecessor_revision_id: issue.predecessor_revision_id ?? null,
    requirement_revision_id: issue.requirement_revision_id ?? null,
    baseline_oid: issue.baseline_oid ?? null,
    target_branch: issue.target_branch ?? null,
    input: issue.input,
  })),
});

export const publishAuthoringBinding = (input: {
  canonical_remote: string;
  requirement: { requirement_id?: string; expected_revision_id?: string; require_current?: boolean; input?: unknown };
  issues: { issue_id?: string; expected_revision_id?: string; requirement_revision_id?: string; baseline: { git_oid: string }; target_branch?: unknown; input: unknown }[];
}): PublishBinding => ({
  canonical_remote: input.canonical_remote,
  requirement: {
    requirement_id: input.requirement.requirement_id,
    requirement_revision_id: input.requirement.expected_revision_id,
    require_current: input.requirement.require_current,
    content: input.requirement.input,
  },
  issues: input.issues.map(issue => ({
    issue_id: issue.issue_id,
    predecessor_revision_id: issue.expected_revision_id,
    requirement_revision_id: issue.requirement_revision_id,
    baseline_oid: issue.baseline.git_oid,
    target_branch: issue.target_branch,
    input: issue.input,
  })),
});

export const issueWriteBinding = (input: {
  canonical_remote?: string;
  requirement_revision_id?: string;
  predecessor_requirement_revision_id?: string;
  issue_id?: string;
  expected_predecessor_id?: string;
  baseline_oid: string;
  target_branch: unknown;
  issue_input: unknown;
}): PublishBinding => ({
  canonical_remote: input.canonical_remote,
  requirement: input.requirement_revision_id !== undefined || input.predecessor_requirement_revision_id !== undefined
    ? { requirement_revision_id: input.requirement_revision_id, predecessor_revision_id: input.predecessor_requirement_revision_id }
    : undefined,
  issues: [{ issue_id: input.issue_id, predecessor_revision_id: input.expected_predecessor_id, baseline_oid: input.baseline_oid, target_branch: input.target_branch, input: input.issue_input }],
});
