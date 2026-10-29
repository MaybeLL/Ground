import { closeSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { sha256 } from "./canonical-json.js";
import { isGitOID, isSha256, isUUIDv7 } from "./identity.js";
import { DomainError, validation } from "./errors.js";
import { safeYAMLToJS } from "./yaml-safe.js";

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export { GIT_CANDIDATE_ARTIFACT_FORMAT } from "./git-artifact-storage.js";
export type { GitCommitArtifact } from "./git-artifact-storage.js";
export const CANDIDATE_ARTIFACT_FORMAT = "patchledger.git-full-index-binary-patch/v1";
export const VERIFICATION_REPORT_FORMAT = "patchledger.verification-report/v1";
export const QUICKSTART_FORMAT = "patchledger.quickstart/v1";

export interface DevRun {
  execution_mode?: import("./development-mode.js").DevelopmentModeSelection;
  initial_base_commit?: string;
  development?: import("./development-branch.js").DevelopmentIdentity;
  artifact_restoration?: { method: "base_patch"; parent_candidate_id: string; source_history: "not_reconstructed" };
  id: string;
  base_commit?: string;
  issue_revision_id: string;
  version: number;
  state: "open" | "submitted" | "abandoned";
  exploration_brief?: string;
  refines_candidate_id?: string;
  repository_remote_snapshot: string;
  abandon_reason?: string;
  created_at: string;
  attribution: Attribution;
}

export interface Attribution {
  kind: "human" | "agent";
  git_name?: string;
  git_email?: string;
  agent_id?: string;
  display_name?: string;
}

export const validateAttribution = (value: Attribution): void => {
  if (!isRecord(value)) throw validation("attribution", "must be an object");
  if (value.kind === "human") {
    if (Object.keys(value).some((key) => !["kind", "git_name", "git_email"].includes(key))) {
      throw validation("attribution", "human attribution contains an unknown field");
    }
    if (!value.git_name || !value.git_email || value.agent_id !== undefined || value.display_name !== undefined) {
      throw validation("attribution", "human attribution requires git_name and git_email only");
    }
    lengthBetween("attribution.git_name", value.git_name, 1, 500);
    lengthBetween("attribution.git_email", value.git_email, 1, 1024);
    return;
  }
  if (value.kind === "agent") {
    if (Object.keys(value).some((key) => !["kind", "agent_id", "display_name"].includes(key))) {
      throw validation("attribution", "agent attribution contains an unknown field");
    }
    if (!value.agent_id || !value.display_name || value.git_name !== undefined || value.git_email !== undefined) {
      throw validation("attribution", "agent attribution requires agent_id and display_name only");
    }
    lengthBetween("attribution.agent_id", value.agent_id, 1, 500);
    lengthBetween("attribution.display_name", value.display_name, 1, 500);
    return;
  }
  throw validation("attribution.kind", "must be human or agent");
};

export interface Decision {
  statement: string;
  rationale?: string;
  context?: string;
  options?: DecisionOption[];
  chosen_option?: string;
  trade_offs?: DecisionTradeOff[];
  consequences?: DecisionConsequence[];
}

export interface DecisionOption {
  key: string;
  description: string;
  benefits?: string[];
  costs?: string[];
}

export interface DecisionTradeOff {
  gain: string;
  sacrifice: string;
  reason: string;
}

export interface DecisionConsequence {
  kind: "benefit" | "obligation" | "risk" | "limitation";
  statement: string;
}

export const decisionDetails = ({ statement: _statement, rationale: _rationale, ...details }: Decision): Omit<Decision, "statement" | "rationale"> => details;

/** Validate the same value at authoring and persisted-record boundaries. */
export const validateDecision = (decision: Decision, field = "decision"): void => {
  const object = (value: unknown, path: string, keys: string[]): void => {
    if (!isRecord(value)) throw validation(path, "must be an object");
    if (Object.keys(value).some((key) => !keys.includes(key))) throw validation(path, "contains an unknown field");
  };
  const array = (value: unknown, path: string, minimum = 0): void => {
    if (!Array.isArray(value) || value.length < minimum || value.length > 100) throw validation(path, `must contain between ${minimum} and 100 entries`);
  };
  object(decision, field, ["statement", "rationale", "context", "options", "chosen_option", "trade_offs", "consequences"]);
  lengthBetween(`${field}.statement`, decision.statement, 1, 4096);
  if (decision.rationale !== undefined) lengthBetween(`${field}.rationale`, decision.rationale, 0, 16384);
  if (decision.context !== undefined) lengthBetween(`${field}.context`, decision.context, 1, 16384);
  if (decision.options !== undefined) {
    array(decision.options, `${field}.options`, 1);
    const keys = new Set<string>();
    decision.options.forEach((option, index) => {
      const path = `${field}.options[${index}]`;
      object(option, path, ["key", "description", "benefits", "costs"]);
      lengthBetween(`${path}.key`, option.key, 1, 64);
      if (!/^[a-z][a-z0-9-]*$/.test(option.key) || keys.has(option.key)) throw validation(`${path}.key`, "must be a unique lowercase option key");
      keys.add(option.key);
      lengthBetween(`${path}.description`, option.description, 1, 4096);
      for (const name of ["benefits", "costs"] as const) {
        if (option[name] !== undefined) {
          array(option[name], `${path}.${name}`);
          option[name]!.forEach((text, i) => lengthBetween(`${path}.${name}[${i}]`, text, 1, 4096));
        }
      }
    });
    if (typeof decision.chosen_option !== "string" || !keys.has(decision.chosen_option)) throw validation(`${field}.chosen_option`, "must reference an option key in this Decision");
  } else if (decision.chosen_option !== undefined) {
    throw validation(`${field}.chosen_option`, "requires options");
  }
  if (decision.trade_offs !== undefined) {
    array(decision.trade_offs, `${field}.trade_offs`);
    decision.trade_offs.forEach((item, index) => {
      const path = `${field}.trade_offs[${index}]`;
      object(item, path, ["gain", "sacrifice", "reason"]);
      lengthBetween(`${path}.gain`, item.gain, 1, 4096);
      lengthBetween(`${path}.sacrifice`, item.sacrifice, 1, 4096);
      lengthBetween(`${path}.reason`, item.reason, 1, 16384);
    });
  }
  if (decision.consequences !== undefined) {
    array(decision.consequences, `${field}.consequences`);
    decision.consequences.forEach((item, index) => {
      const path = `${field}.consequences[${index}]`;
      object(item, path, ["kind", "statement"]);
      if (!["benefit", "obligation", "risk", "limitation"].includes(item.kind)) throw validation(`${path}.kind`, "must be benefit, obligation, risk, or limitation");
      lengthBetween(`${path}.statement`, item.statement, 1, 4096);
    });
  }
};

export interface OpenQuestion {
  question: string;
  blocking: boolean;
  assumption?: string;
}

export interface RequirementInput {
  format: number;
  summary: string;
  context?: string;
  outcomes: string[];
  decisions?: Decision[];
  open_questions?: OpenQuestion[];
}

export const validateRequirementInput = (value: RequirementInput): void => {
  if (!isRecord(value)) throw validation("file", "must be an object");
  if (value.format !== 1) throw validation("format", "must equal 1");
  lengthBetween("summary", value.summary, 1, 500);
  if (value.context !== undefined) lengthBetween("context", value.context, 0, 65536);
  if (!Array.isArray(value.outcomes) || value.outcomes.length < 1 || value.outcomes.length > 100) {
    throw validation("outcomes", "must contain between 1 and 100 entries");
  }
  value.outcomes.forEach((entry, index) => lengthBetween(`outcomes[${index}]`, entry, 1, 4096));
  if (value.decisions !== undefined) {
    if (!Array.isArray(value.decisions)) throw validation("decisions", "must be an array");
    if (value.decisions.length > 100) throw validation("decisions", "must contain at most 100 entries");
    value.decisions.forEach((decision, index) => validateDecision(decision, `decisions[${index}]`));
  }
  if (value.open_questions !== undefined) {
    if (!Array.isArray(value.open_questions)) throw validation("open_questions", "must be an array");
    if (value.open_questions.length > 100) throw validation("open_questions", "must contain at most 100 entries");
    value.open_questions.forEach((question, index) => {
      if (!isRecord(question)) throw validation(`open_questions[${index}]`, "must be an object");
      if (Object.keys(question).some((key) => !["question", "blocking", "assumption"].includes(key))) throw validation(`open_questions[${index}]`, "contains an unknown field");
      lengthBetween(`open_questions[${index}].question`, question.question, 1, 4096);
      if (typeof question.blocking !== "boolean") throw validation(`open_questions[${index}].blocking`, "must be boolean");
      if (question.assumption !== undefined) lengthBetween(`open_questions[${index}].assumption`, question.assumption, 1, 16384);
    });
  }
};

export interface RequirementRevision {
  id: string;
  requirement_id: string;
  revision_number: number;
  predecessor_revision_id?: string;
  summary: string;
  context?: string;
  outcomes: string[];
  decisions: Decision[];
  open_questions?: OpenQuestion[];
}

export interface IntentLink {
  type: "outcome" | "decision";
  ordinal: number;
}

export interface TargetInput {
  statement: string;
  criteria: string[];
  guidance?: string[];
  traces_to?: IntentLink[];
}

export interface ConstraintInput extends TargetInput {
  rationale?: string;
}

export interface TargetBranch { remote: string; ref: string }

/** Git-independent syntax guard at the domain/storage boundary. Clone identity is checked by the caller. */
export function validateTargetBranchSpec(value: TargetBranch): void {
  if (!isRecord(value) || Object.keys(value).some(key => !["remote", "ref"].includes(key))) throw validation("target_branch", "requires only remote and ref");
  lengthBetween("target_branch.remote", value.remote, 1, 256);
  lengthBetween("target_branch.ref", value.ref, 1, 1024);
  const validRef = (ref: string): boolean => !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
    && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".")
    && ref.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".lock"));
  if (value.remote.startsWith("-") || !validRef(`refs/remotes/${value.remote}/probe`)) throw validation("target_branch.remote", "invalid remote name");
  if (!value.ref.startsWith("refs/heads/") || !validRef(value.ref)) throw validation("target_branch.ref", "must be a valid full refs/heads/ branch ref");
}

export interface IssueInput {
  format: number;
  target_branch?: TargetBranch;
  summary: string;
  context?: string;
  /**
   * Non-normative overall approach: context for the developer and reader, not
   * an acceptance obligation. Anything binding must appear in a goal or
   * constraint with its own criteria. Empty or whitespace-only means absent.
   */
  plan?: string;
  goals: TargetInput[];
  constraints?: ConstraintInput[];
}

export interface QuickstartInput {
  format: string;
  requirement: RequirementInput;
  issue: IssueInput;
}

const validateTarget = (prefix: string, value: TargetInput, constraint = false): void => {
  if (!isRecord(value)) throw validation(prefix, "must be an object");
  const allowed = constraint ? ["statement", "criteria", "guidance", "traces_to", "rationale"] : ["statement", "criteria", "guidance", "traces_to"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw validation(prefix, "contains an unknown field");
  lengthBetween(`${prefix}.statement`, value.statement, 1, 4096);
  if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 50) {
    throw validation(`${prefix}.criteria`, "must contain between 1 and 50 entries");
  }
  value.criteria.forEach((entry, index) => lengthBetween(`${prefix}.criteria[${index}]`, entry, 1, 4096));
  if (value.guidance !== undefined) {
    if (!Array.isArray(value.guidance)) throw validation(`${prefix}.guidance`, "must be an array");
    if (value.guidance.length > 50) throw validation(`${prefix}.guidance`, "must contain at most 50 entries");
    value.guidance.forEach((entry, index) => lengthBetween(`${prefix}.guidance[${index}]`, entry, 1, 4096));
  }
  if (value.traces_to !== undefined) {
    if (!Array.isArray(value.traces_to) || value.traces_to.length < 1 || value.traces_to.length > 200) throw validation(`${prefix}.traces_to`, "must contain between 1 and 200 entries");
    const seen = new Set<string>();
    value.traces_to.forEach((link, index) => {
      const field = `${prefix}.traces_to[${index}]`;
      if (!isRecord(link) || Object.keys(link).some((key) => !["type", "ordinal"].includes(key))) throw validation(field, "must contain only type and ordinal");
      if (link.type !== "outcome" && link.type !== "decision") throw validation(`${field}.type`, "must be outcome or decision");
      if (!Number.isSafeInteger(link.ordinal) || link.ordinal < 1 || link.ordinal > 100) throw validation(`${field}.ordinal`, "must be an integer between 1 and 100");
      const key = `${link.type}:${link.ordinal}`;
      if (seen.has(key)) throw validation(field, "must not duplicate another Intent Link on the same target");
      seen.add(key);
    });
  }
};

export const validateIssueInput = (value: IssueInput): void => {
  if (!isRecord(value)) throw validation("file", "must be an object");
  if (value.format !== 1) throw validation("format", "must equal 1");
  if (value.target_branch !== undefined) validateTargetBranchSpec(value.target_branch);
  lengthBetween("summary", value.summary, 1, 500);
  if (value.context !== undefined) lengthBetween("context", value.context, 1, 65536);
  if (value.plan !== undefined) {
    lengthBetween("plan", value.plan, 1, 65536);
    // v3 narrowed this deliberately: a whitespace-only plan carries no meaning,
    // and silently treating it as absent hides an authoring slip. Reject it so
    // the author sees the problem instead of publishing an empty section.
    if (value.plan.trim() === "") throw validation("plan", "must not be empty or whitespace-only; omit it instead");
    // A heading equal to a semantic section name would collide with the
    // authoring parser's section splitting. Plan is non-normative prose, so
    // reserve those names rather than trying to disambiguate them.
    const reserved = ["Summary", "Context", "Plan", "Goals", "Constraints", "Open Questions", "Assumptions"];
    for (const line of value.plan.split("\n")) {
      const heading = /^#{1,2}\s+(.+?)\s*$/.exec(line);
      if (heading && reserved.includes(heading[1])) throw validation("plan", `must not contain the reserved section heading "${heading[1]}"`);
    }
  }
  if (!Array.isArray(value.goals) || value.goals.length < 1 || value.goals.length > 100) {
    throw validation("goals", "must contain between 1 and 100 entries");
  }
  value.goals.forEach((goal, index) => validateTarget(`goals[${index}]`, goal));
  if (value.constraints !== undefined) {
    if (!Array.isArray(value.constraints)) throw validation("constraints", "must be an array");
    if (value.constraints.length > 100) throw validation("constraints", "must contain at most 100 entries");
    value.constraints.forEach((constraint, index) => {
      if (!isRecord(constraint)) throw validation(`constraints[${index}]`, "must be an object");
      validateTarget(`constraints[${index}]`, constraint, true);
      if (constraint.rationale !== undefined) lengthBetween(`constraints[${index}].rationale`, constraint.rationale, 1, 16384);
    });
  }
};

export const validateIssueIntentLinks = (
  issue: Pick<IssueInput | IssueRevision, "goals" | "constraints">,
  requirement: Pick<RequirementInput | RequirementRevision, "outcomes" | "decisions">,
): void => {
  const decisions = requirement.decisions ?? [];
  const validate = (kind: "goals" | "constraints", targets: Array<{ traces_to?: IntentLink[] }>): void => {
    targets.forEach((target, targetIndex) => target.traces_to?.forEach((link, linkIndex) => {
      const available = link.type === "outcome" ? requirement.outcomes.length : decisions.length;
      if (link.ordinal > available) throw validation(`${kind}[${targetIndex}].traces_to[${linkIndex}].ordinal`, `does not identify an ${link.type} in the bound Requirement Version`);
    }));
  };
  validate("goals", issue.goals);
  validate("constraints", issue.constraints ?? []);
};

const validateNestedInput = (prefix: string, validate: () => void): void => {
  try {
    validate();
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "VALIDATION_ERROR") throw error;
    const field = String(error.details.field ?? "file");
    const reason = String(error.details.reason ?? error.message);
    throw validation(field === "file" ? prefix : `${prefix}.${field}`, reason);
  }
};

export const validateQuickstartInput = (value: QuickstartInput): void => {
  if (!isRecord(value)) throw validation("file", "must be an object");
  if (value.format !== QUICKSTART_FORMAT) throw validation("format", `must equal ${QUICKSTART_FORMAT}`);
  validateNestedInput("requirement", () => validateRequirementInput(value.requirement));
  validateNestedInput("issue", () => validateIssueInput(value.issue));
};

export interface Baseline {
  git_oid: string;
  reachability: "remote_tracking_reachable" | "unconfirmed";
  warning?: string;
  override_reason?: string;
}

export const validateBaseline = (value: Baseline): void => {
  if (!isRecord(value)) throw validation("baseline", "must be an object");
  if (!isGitOID(value.git_oid)) throw validation("baseline.git_oid", "must be an algorithm-prefixed SHA-1 or SHA-256 Git object ID");
  if (value.reachability === "remote_tracking_reachable") {
    if (value.warning !== undefined || value.override_reason !== undefined) throw validation("baseline", "reachable baselines cannot contain warning or override_reason");
    return;
  }
  if (value.reachability !== "unconfirmed") throw validation("baseline.reachability", "must be remote_tracking_reachable or unconfirmed");
  if (value.warning === undefined) throw validation("baseline.warning", "is required for an unconfirmed baseline");
  lengthBetween("baseline.warning", value.warning, 1, 4096);
  if (value.override_reason !== undefined) lengthBetween("baseline.override_reason", value.override_reason, 1, 65536);
};

export interface Criterion {
  id: string;
  statement: string;
}

export interface Goal {
  id: string;
  statement: string;
  criteria: Criterion[];
  guidance: string[];
  traces_to?: IntentLink[];
}

export interface Constraint {
  id: string;
  statement: string;
  criteria: Criterion[];
  guidance: string[];
  rationale?: string;
  traces_to?: IntentLink[];
}

export interface IssueRevision {
  id: string;
  issue_id: string;
  requirement_id: string;
  requirement_revision_id: string;
  revision_number: number;
  predecessor_revision_id?: string;
  baseline: Baseline;
  target_branch?: TargetBranch;
  summary: string;
  context?: string;
  /** Non-normative approach; sealed with the version but never an acceptance obligation. */
  plan?: string;
  goals: Goal[];
  constraints: Constraint[];
}

export type EvidenceInput =
  | { type: "command"; command: string; exit_code: number; output?: string }
  | { type: "artifact"; name: string; media_type: string; content_base64: string }
  | { type: "observation"; statement: string; attribution: Attribution }
  | { type: "external_reference"; url: string; content_digest: string; title?: string };

export interface SelfVerification {
  status: "satisfied" | "partially_satisfied" | "not_satisfied" | "inconclusive" | "not_verified";
  explanation: string;
  method?: string;
}

export interface CriterionClaimInput {
  criterion_id: string;
  explanation: string;
  evidence: EvidenceInput[];
  self_verification?: SelfVerification;
}

export interface ClaimInput {
  target_type: "goal" | "constraint";
  target_id: string;
  explanation: string;
  criteria: CriterionClaimInput[];
}

export interface CandidateSubmissionBaseInput {
  explanation: string;
  claims: ClaimInput[];
}

export interface CandidateSubmissionV1Input extends CandidateSubmissionBaseInput {
  format: "patchledger.candidate-submission/v1";
}

export type ChangeRationaleRelation = "implements" | "verifies" | "supports" | "generated" | "incidental";

export interface ChangeRationaleInput {
  change_refs: string[];
  relation: ChangeRationaleRelation;
  target_refs: { type: "criterion"; id: string }[];
  rationale: string;
  alternatives: { approach: string; rejected_because: string }[];
  risks: string[];
}

export interface CandidateSubmissionV2Input extends CandidateSubmissionBaseInput {
  format: "patchledger.candidate-submission/v2";
  change_index: {
    format: "patchledger.change-index/v1";
    patch_digest: string;
    units_digest: string;
  };
  change_rationales: ChangeRationaleInput[];
}

export type CandidateSubmissionInput = CandidateSubmissionV1Input | CandidateSubmissionV2Input;

export interface CandidateFile {
  path_bytes: string;
  display_path: string;
  change: string;
  old_path_bytes?: string;
  old_mode?: string;
  new_mode?: string;
}

export interface CandidateArtifact {
  patch: Buffer;
  patch_digest: string;
  result_tree_oid: string;
  uncompressed_size: number;
  files: CandidateFile[];
}

export interface Candidate {
  git_artifact?: import("./git-artifact-storage.js").GitCommitArtifact;
  source?: import("./development-branch.js").SourceIdentity;
  id: string;
  base_commit?: string;
  dev_run_id: string;
  issue_revision_id: string;
  repository_remote_snapshot: string;
  submission: CandidateSubmissionInput;
  patch_digest: string;
  result_tree_oid: string;
  artifact_format: string;
  blind_context_digest: string;
  created_at: string;
  attribution: Attribution;
}

export type EvidenceRecord = EvidenceInput & { digest: string };

export interface CriterionClaimRecord {
  criterion_id: string;
  explanation: string;
  evidence: EvidenceRecord[];
  self_verification?: SelfVerification;
}

export interface ClaimRecord {
  target_type: "goal" | "constraint";
  target_id: string;
  explanation: string;
  criteria: CriterionClaimRecord[];
  self_verification_summary?: SelfVerificationSummary;
}

export type SelfVerificationSummary = Record<SelfVerification["status"] | "not_recorded", number>;
export const summarizeSelfVerification = (criteria: { self_verification?: SelfVerification }[]): SelfVerificationSummary => {
  const summary: SelfVerificationSummary = { satisfied: 0, partially_satisfied: 0, not_satisfied: 0, inconclusive: 0, not_verified: 0, not_recorded: 0 };
  for (const criterion of criteria) summary[criterion.self_verification?.status ?? "not_recorded"]++;
  return summary;
};

export const evidenceDigest = (value: EvidenceInput): string => sha256(value);

export const claimRecords = (claims: ClaimInput[]): ClaimRecord[] => claims.map((claim) => ({
  target_type: claim.target_type,
  target_id: claim.target_id,
  explanation: claim.explanation,
  ...(claim.criteria.some((criterion) => criterion.self_verification !== undefined) ? { self_verification_summary: summarizeSelfVerification(claim.criteria) } : {}),
  criteria: claim.criteria.map((criterion) => ({
    criterion_id: criterion.criterion_id,
    explanation: criterion.explanation,
    ...(criterion.self_verification ? { self_verification: { ...criterion.self_verification } } : {}),
    evidence: criterion.evidence.map((evidence) => ({ ...evidence, digest: evidenceDigest(evidence) })),
  })),
}));

export const manifestDigest = (files: CandidateFile[]): string => sha256(files ?? []);

export const validateEvidence = (field: string, evidence: EvidenceInput[]): number => {
  if (!Array.isArray(evidence)) throw validation(field, "is required; use an empty array when no evidence is available");
  if (evidence.length > 8) throw validation(field, "must contain at most 8 entries");
  let outputBytes = 0;
  evidence.forEach((item, index) => {
    const prefix = `${field}[${index}]`;
    if (!isRecord(item)) throw validation(prefix, "must be an object");
    const type = item.type;
    const allowed = type === "command" ? ["type", "command", "exit_code", "output"] : type === "artifact" ? ["type", "name", "media_type", "content_base64"] : type === "observation" ? ["type", "statement", "attribution"] : type === "external_reference" ? ["type", "url", "content_digest", "title"] : [];
    if (!allowed.length) throw validation(`${prefix}.type`, "must be command, artifact, observation, or external_reference");
    if (Object.keys(item).some((key) => !allowed.includes(key))) throw validation(prefix, "contains fields that do not belong to this Evidence type");
    if (type === "command") {
      lengthBetween(`${prefix}.command`, item.command, 1, 4096);
      if (!Number.isInteger(item.exit_code) || item.exit_code < -2_147_483_648 || item.exit_code > 2_147_483_647) throw validation(`${prefix}.exit_code`, "must fit a signed 32-bit integer");
      if (item.output !== undefined) { lengthBetween(`${prefix}.output`, item.output, 0, 65536); outputBytes += Buffer.byteLength(item.output, "utf8"); }
    } else if (type === "artifact") {
      lengthBetween(`${prefix}.name`, item.name, 1, 500); lengthBetween(`${prefix}.media_type`, item.media_type, 1, 255);
      if (typeof item.content_base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content_base64)) throw validation(`${prefix}.content_base64`, "must be canonical base64");
      const bytes = Buffer.from(item.content_base64, "base64"); if (bytes.length > 65536) throw validation(`${prefix}.content_base64`, "decoded artifact must not exceed 64 KiB"); outputBytes += bytes.length;
    } else if (type === "observation") {
      lengthBetween(`${prefix}.statement`, item.statement, 1, 65536); validateAttribution(item.attribution); outputBytes += Buffer.byteLength(item.statement, "utf8");
    } else {
      lengthBetween(`${prefix}.url`, item.url, 1, 4096); try { const parsed = new URL(item.url); if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(); } catch { throw validation(`${prefix}.url`, "must be an absolute HTTP or HTTPS URL"); }
      if (!isSha256(item.content_digest)) throw validation(`${prefix}.content_digest`, "must be a sha256 digest so mutable remote content remains identifiable");
      if (item.title !== undefined) lengthBetween(`${prefix}.title`, item.title, 1, 500);
    }
  });
  return outputBytes;
};

export const validateCandidateSubmission = (value: CandidateSubmissionInput): void => {
  if (!isRecord(value)) throw validation("file", "must be an object");
  if (value.format !== "patchledger.candidate-submission/v1" && value.format !== "patchledger.candidate-submission/v2") throw validation("format", "must equal patchledger.candidate-submission/v1 or patchledger.candidate-submission/v2");
  lengthBetween("explanation", value.explanation, 1, 65536);
  if (!Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > 200) throw validation("claims", "must contain between 1 and 200 entries");
  const targets = new Set<string>();
  let evidenceBytes = 0;
  value.claims.forEach((claim, index) => {
    const prefix = `claims[${index}]`;
    if (!isRecord(claim)) throw validation(prefix, "must be an object");
    if (claim.target_type !== "goal" && claim.target_type !== "constraint") throw validation(`${prefix}.target_type`, "must be goal or constraint");
    if (!isUUIDv7(claim.target_id)) throw validation(`${prefix}.target_id`, "must be a lowercase UUIDv7");
    lengthBetween(`${prefix}.explanation`, claim.explanation, 1, 65536);
    const targetKey = `${claim.target_type}:${claim.target_id}`;
    if (targets.has(targetKey)) throw validation(`${prefix}.target_id`, "must not be duplicated");
    targets.add(targetKey);
    if (!Array.isArray(claim.criteria) || claim.criteria.length < 1 || claim.criteria.length > 50) throw validation(`${prefix}.criteria`, "must contain between 1 and 50 entries");
    const criteria = new Set<string>();
    claim.criteria.forEach((criterion, criterionIndex) => {
      const criterionPrefix = `${prefix}.criteria[${criterionIndex}]`;
      if (!isRecord(criterion)) throw validation(criterionPrefix, "must be an object");
      if (!isUUIDv7(criterion.criterion_id)) throw validation(`${criterionPrefix}.criterion_id`, "must be a lowercase UUIDv7");
      lengthBetween(`${criterionPrefix}.explanation`, criterion.explanation, 1, 65536);
      if (criteria.has(criterion.criterion_id)) throw validation(`${criterionPrefix}.criterion_id`, "must not be duplicated");
      criteria.add(criterion.criterion_id);
      evidenceBytes += validateEvidence(`${criterionPrefix}.evidence`, criterion.evidence);
      if (criterion.self_verification !== undefined) {
        const field = `${criterionPrefix}.self_verification`;
        const check = criterion.self_verification;
        if (!isRecord(check) || Object.keys(check).some((key) => !["status", "explanation", "method"].includes(key))) throw validation(field, "must contain only status, explanation and optional method");
        if (!["satisfied", "partially_satisfied", "not_satisfied", "inconclusive", "not_verified"].includes(check.status)) throw validation(`${field}.status`, "invalid self-verification status");
        lengthBetween(`${field}.explanation`, check.explanation, 1, 65536);
        if (check.status === "not_verified") {
          if (check.method !== undefined) throw validation(`${field}.method`, "must be absent when no check was performed");
        } else {
          if (typeof check.method !== "string") throw validation(`${field}.method`, "is required for a performed check");
          lengthBetween(`${field}.method`, check.method, 1, 65536);
          if (!criterion.evidence.length) throw validation(`${criterionPrefix}.evidence`, "a self-verification check requires attributed supporting evidence");
        }
      }
    });
  });
  if (evidenceBytes > 1024 * 1024) throw validation("claims", "all evidence output must not exceed 1 MiB");
  if (value.format === "patchledger.candidate-submission/v1") {
    if ("change_index" in value || "change_rationales" in value) throw validation("format", "v1 must not contain v2 change rationale fields");
    return;
  }
  if (Object.keys(value).some((key) => !["format", "explanation", "claims", "change_index", "change_rationales"].includes(key))) throw validation("file", "contains an unknown CandidateSubmission v2 field");
  if (!isRecord(value.change_index)) throw validation("change_index", "is required and must be an object");
  if (Object.keys(value.change_index).some((key) => !["format", "patch_digest", "units_digest"].includes(key))) throw validation("change_index", "contains an unknown field");
  if (value.change_index.format !== "patchledger.change-index/v1") throw validation("change_index.format", "must equal patchledger.change-index/v1");
  if (!isSha256(value.change_index.patch_digest)) throw validation("change_index.patch_digest", "must be a lowercase sha256 digest");
  if (!isSha256(value.change_index.units_digest)) throw validation("change_index.units_digest", "must be a lowercase sha256 digest");
  if (!Array.isArray(value.change_rationales) || value.change_rationales.length > 10000) throw validation("change_rationales", "must be an array of at most 10000 entries");
  let rationaleBytes = 0;
  let changeRefCount = 0;
  let targetRefCount = 0;
  const relations = new Set<ChangeRationaleRelation>(["implements", "verifies", "supports", "generated", "incidental"]);
  value.change_rationales.forEach((rationale, index) => {
    const prefix = `change_rationales[${index}]`;
    if (!isRecord(rationale)) throw validation(prefix, "must be an object");
    if (Object.keys(rationale).some((key) => !["change_refs", "relation", "target_refs", "rationale", "alternatives", "risks"].includes(key))) throw validation(prefix, "contains an unknown field");
    if (!Array.isArray(rationale.change_refs) || rationale.change_refs.length < 1 || rationale.change_refs.length > 1000) throw validation(`${prefix}.change_refs`, "must contain between 1 and 1000 Change Unit IDs");
    changeRefCount += rationale.change_refs.length;
    if (new Set(rationale.change_refs).size !== rationale.change_refs.length || rationale.change_refs.some((id) => !isSha256(id))) throw validation(`${prefix}.change_refs`, "must contain unique lowercase sha256 Change Unit IDs");
    if (!relations.has(rationale.relation)) throw validation(`${prefix}.relation`, "must be implements, verifies, supports, generated, or incidental");
    if (!Array.isArray(rationale.target_refs) || rationale.target_refs.length < 1 || rationale.target_refs.length > 200) throw validation(`${prefix}.target_refs`, "must contain between 1 and 200 Criterion references");
    targetRefCount += rationale.target_refs.length;
    const targetIDs = new Set<string>();
    rationale.target_refs.forEach((target, targetIndex) => {
      if (!isRecord(target) || Object.keys(target).some((key) => key !== "type" && key !== "id") || target.type !== "criterion" || !isUUIDv7(target.id)) throw validation(`${prefix}.target_refs[${targetIndex}]`, "must be a Criterion reference with a lowercase UUIDv7 id");
      if (targetIDs.has(target.id)) throw validation(`${prefix}.target_refs`, "must not contain duplicate Criterion references");
      targetIDs.add(target.id);
    });
    lengthBetween(`${prefix}.rationale`, rationale.rationale, 1, 16384);
    if (rationale.rationale.startsWith("TODO:")) throw validation(`${prefix}.rationale`, "must replace the generated TODO placeholder");
    rationaleBytes += Buffer.byteLength(rationale.rationale, "utf8");
    if (!Array.isArray(rationale.alternatives) || rationale.alternatives.length > 20) throw validation(`${prefix}.alternatives`, "must be an array of at most 20 entries");
    rationale.alternatives.forEach((alternative, alternativeIndex) => {
      if (!isRecord(alternative)) throw validation(`${prefix}.alternatives[${alternativeIndex}]`, "must be an object");
      if (Object.keys(alternative).some((key) => key !== "approach" && key !== "rejected_because")) throw validation(`${prefix}.alternatives[${alternativeIndex}]`, "contains an unknown field");
      lengthBetween(`${prefix}.alternatives[${alternativeIndex}].approach`, alternative.approach, 1, 4096);
      lengthBetween(`${prefix}.alternatives[${alternativeIndex}].rejected_because`, alternative.rejected_because, 1, 16384);
      rationaleBytes += Buffer.byteLength(alternative.approach, "utf8") + Buffer.byteLength(alternative.rejected_because, "utf8");
    });
    if (!Array.isArray(rationale.risks) || rationale.risks.length > 50) throw validation(`${prefix}.risks`, "must be an array of at most 50 entries");
    rationale.risks.forEach((risk, riskIndex) => { lengthBetween(`${prefix}.risks[${riskIndex}]`, risk, 1, 4096); rationaleBytes += Buffer.byteLength(risk, "utf8"); });
  });
  if (changeRefCount > 100000) throw validation("change_rationales", "must contain at most 100000 total Change Unit references");
  if (targetRefCount > 200000) throw validation("change_rationales", "must contain at most 200000 total Criterion references");
  if (rationaleBytes > 1024 * 1024) throw validation("change_rationales", "all rationale text must not exceed 1 MiB");
};

export interface VerificationAssessmentStageInput {
  verdict: "qualified" | "rejected" | "inconclusive";
  explanation: string;
  evidence: EvidenceInput[];
}

export interface VerificationReconciliationInput {
  claim_relation: "corroborated" | "contradicted" | "not_determined";
  explanation: string;
}

export interface VerificationFinalAssessmentInput {
  verdict: "qualified" | "rejected" | "inconclusive";
  explanation: string;
}

export interface VerificationCriterionAssessmentInput {
  criterion_id: string;
  independent: VerificationAssessmentStageInput;
  reconciliation: VerificationReconciliationInput;
  final: VerificationFinalAssessmentInput;
}

export interface VerificationTargetAssessmentInput {
  target_type: "goal" | "constraint";
  target_id: string;
  criteria: VerificationCriterionAssessmentInput[];
}

export interface VerificationReportInput {
  format: string;
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  assessments: VerificationTargetAssessmentInput[];
}

export interface Verification {
  id: string;
  candidate_id: string;
  result_tree_oid: string;
  blind_context_digest: string;
  overall_verdict: "qualified" | "rejected" | "inconclusive";
  created_at: string;
  attribution: Attribution;
}

export const validateVerificationReport = (value: VerificationReportInput): void => {
  if (!isRecord(value)) throw validation("file", "must be an object");
  if (value.format !== VERIFICATION_REPORT_FORMAT) throw validation("format", `must equal ${VERIFICATION_REPORT_FORMAT}`);
  if (!isUUIDv7(value.candidate_id)) throw validation("candidate_id", "must be a lowercase UUIDv7");
  if (!isGitOID(value.result_tree_oid)) throw validation("result_tree_oid", "must be an algorithm-prefixed SHA-1 or SHA-256 Git object ID");
  if (!isSha256(value.blind_context_digest)) throw validation("blind_context_digest", "must be a lowercase sha256 digest");
  if (!Array.isArray(value.assessments) || value.assessments.length < 1 || value.assessments.length > 200) throw validation("assessments", "must contain between 1 and 200 entries");
  const targets = new Set<string>();
  let evidenceBytes = 0;
  const verdicts = new Set(["qualified", "rejected", "inconclusive"]);
  value.assessments.forEach((assessment, index) => {
    const prefix = `assessments[${index}]`;
    if (!isRecord(assessment)) throw validation(prefix, "must be an object");
    if (assessment.target_type !== "goal" && assessment.target_type !== "constraint") throw validation(`${prefix}.target_type`, "must be goal or constraint");
    if (!isUUIDv7(assessment.target_id)) throw validation(`${prefix}.target_id`, "must be a lowercase UUIDv7");
    const key = `${assessment.target_type}:${assessment.target_id}`;
    if (targets.has(key)) throw validation(`${prefix}.target_id`, "must not be duplicated");
    targets.add(key);
    if (!Array.isArray(assessment.criteria) || assessment.criteria.length < 1 || assessment.criteria.length > 50) throw validation(`${prefix}.criteria`, "must contain between 1 and 50 entries");
    const criteria = new Set<string>();
    assessment.criteria.forEach((criterion, criterionIndex) => {
      const cp = `${prefix}.criteria[${criterionIndex}]`;
      if (!isRecord(criterion)) throw validation(cp, "must be an object");
      if (!isUUIDv7(criterion.criterion_id)) throw validation(`${cp}.criterion_id`, "must be a lowercase UUIDv7");
      if (criteria.has(criterion.criterion_id)) throw validation(`${cp}.criterion_id`, "must not be duplicated");
      criteria.add(criterion.criterion_id);
      if (!isRecord(criterion.independent)) throw validation(`${cp}.independent`, "must be an object");
      if (!isRecord(criterion.reconciliation)) throw validation(`${cp}.reconciliation`, "must be an object");
      if (!isRecord(criterion.final)) throw validation(`${cp}.final`, "must be an object");
      if (!verdicts.has(criterion.independent.verdict)) throw validation(`${cp}.independent.verdict`, "must be qualified, rejected, or inconclusive");
      lengthBetween(`${cp}.independent.explanation`, criterion.independent.explanation, 1, 65536);
      evidenceBytes += validateEvidence(`${cp}.independent.evidence`, criterion.independent.evidence);
      if (!new Set(["corroborated", "contradicted", "not_determined"]).has(criterion.reconciliation.claim_relation)) throw validation(`${cp}.reconciliation.claim_relation`, "must be corroborated, contradicted, or not_determined");
      lengthBetween(`${cp}.reconciliation.explanation`, criterion.reconciliation.explanation, 1, 65536);
      if (!verdicts.has(criterion.final.verdict)) throw validation(`${cp}.final.verdict`, "must be qualified, rejected, or inconclusive");
      lengthBetween(`${cp}.final.explanation`, criterion.final.explanation, 1, 65536);
    });
  });
  if (evidenceBytes > 1024 * 1024) throw validation("assessments", "all evidence output must not exceed 1 MiB");
};

export const lengthBetween = (field: string, value: string, minimum: number, maximum: number): void => {
  // A non-string scalar (or an object/array) reaching a text field is usually a
  // YAML parsing artifact.  Explain the mapping case so the author can quote
  // the offending line instead of guessing which word folded into a map.
  if (typeof value !== "string") throw validation(field, typeof value === "object" && value !== null ? scalarShapeReason(field, value) : "must be a string");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw validation(field, "must contain valid UTF-8 text");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw validation(field, "must contain valid UTF-8 text");
    }
  }
  const length = [...value].length;
  if (length < minimum || length > maximum) throw validation(field, `must contain between ${minimum} and ${maximum} characters`);
};

/** Validate optional long text fields used by DevRuns and similar commands.
 * A present value must contain 1..65536 UTF-8 characters; keeping this
 * helper at the domain boundary also rejects lone UTF-16 surrogates before
 * canonical JSON or SQL sees them. */
export const validateOptionalLongText = (field: string, value: string | undefined): void => {
  if (value === undefined) return;
  lengthBetween(field, value, 1, 65536);
};

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type ShapeSpec = "scalar" | "array" | { arrayOf: Shape } | Shape;
export interface Shape { [key: string]: ShapeSpec }
export const objectArray = (arrayOf: Shape): ShapeSpec => ({ arrayOf });
const requirementShape: Shape = { format: "scalar", summary: "scalar", context: "scalar", outcomes: "array", decisions: objectArray({ statement: "scalar", rationale: "scalar", context: "scalar", chosen_option: "scalar", options: objectArray({ key: "scalar", description: "scalar", benefits: "array", costs: "array" }), trade_offs: objectArray({ gain: "scalar", sacrifice: "scalar", reason: "scalar" }), consequences: objectArray({ kind: "scalar", statement: "scalar" }) }), open_questions: objectArray({ question: "scalar", blocking: "scalar", assumption: "scalar" }) };
const issueShape: Shape = { format: "scalar", target_branch: { remote: "scalar", ref: "scalar" }, summary: "scalar", context: "scalar", plan: "scalar", goals: objectArray({ statement: "scalar", criteria: "array", guidance: "array", traces_to: objectArray({ type: "scalar", ordinal: "scalar" }) }), constraints: objectArray({ statement: "scalar", criteria: "array", guidance: "array", rationale: "scalar", traces_to: objectArray({ type: "scalar", ordinal: "scalar" }) }) };
const quickstartShape: Shape = { format: "scalar", requirement: requirementShape, issue: issueShape };
export const evidenceShape: Shape = { type: "scalar", command: "scalar", exit_code: "scalar", output: "scalar", name: "scalar", media_type: "scalar", content_base64: "scalar", statement: "scalar", attribution: { kind: "scalar", git_name: "scalar", git_email: "scalar", agent_id: "scalar", display_name: "scalar" }, url: "scalar", content_digest: "scalar", title: "scalar" };
const candidateShape: Shape = { format: "scalar", explanation: "scalar", claims: objectArray({ target_type: "scalar", target_id: "scalar", explanation: "scalar", criteria: objectArray({ criterion_id: "scalar", explanation: "scalar", self_verification: { status: "scalar", explanation: "scalar", method: "scalar" }, evidence: objectArray(evidenceShape) }) }), change_index: { format: "scalar", patch_digest: "scalar", units_digest: "scalar" }, change_rationales: objectArray({ change_refs: "array", relation: "scalar", target_refs: objectArray({ type: "scalar", id: "scalar" }), rationale: "scalar", alternatives: objectArray({ approach: "scalar", rejected_because: "scalar" }), risks: "array" }) };
const verificationShape: Shape = { format: "scalar", candidate_id: "scalar", result_tree_oid: "scalar", blind_context_digest: "scalar", assessments: objectArray({ target_type: "scalar", target_id: "scalar", criteria: objectArray({ criterion_id: "scalar", independent: { verdict: "scalar", explanation: "scalar", evidence: objectArray(evidenceShape) }, reconciliation: { claim_relation: "scalar", explanation: "scalar" }, final: { verdict: "scalar", explanation: "scalar" } }) }) };

// Explain why a scalar field arrived as an object/array.  The most common
// cause is YAML folding a bare string containing ": " into an inline mapping;
// surface the parsed keys so the author can quote the string instead of
// guessing which word tripped the parser.
const scalarShapeReason = (field: string, child: unknown): string => {
  if (Array.isArray(child)) return "must be a scalar (a YAML sequence was parsed)";
  if (typeof child === "object" && child !== null) {
    const record = child as Record<string, unknown>;
    const keys = Object.keys(record);
    const preview = keys.slice(0, 3).map((key) => `"${key}"`).join(", ");
    const more = keys.length > 3 ? ` and ${keys.length - 3} more` : "";
    // The value under the first folded key is usually the tail of the intended
    // string; show it as the quote target so the fix is copy-pasteable.
    const example = boundedPreview(String(record[keys[0] ?? ""]));
    return `must be a scalar; YAML parsed this entry as a mapping with key${keys.length === 1 ? "" : "s"} ${preview}${more} — the text contains ": " and must be quoted, e.g. - "${example}"`;
  }
  return "must be a scalar";
};

const boundedPreview = (value: string): string => [...value].length > 48 ? [...value].slice(0, 48).join("") + "…" : value;

const checkShape = (value: unknown, shape: Shape, field: string): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(field, `must be an object, got ${shapeKind(value)}`);
  for (const key of Object.keys(value as object)) {
    if (!(key in shape)) throw validation(`${field}.${key}`, "unknown field");
    const spec = shape[key];
    const child = (value as Record<string, unknown>)[key];
    if (typeof spec === "string") {
      if (spec === "array" && !Array.isArray(child)) throw validation(`${field}.${key}`, `must be an array, got ${shapeKind(child)}`);
      if (spec === "scalar" && (typeof child === "object" || Array.isArray(child))) throw validation(`${field}.${key}`, scalarShapeReason(`${field}.${key}`, child));
      continue;
    }
    if (typeof spec === "object" && spec !== null && Object.prototype.hasOwnProperty.call(spec, "arrayOf")) {
      const arraySpec = spec as { arrayOf: Shape };
      if (!Array.isArray(child)) throw validation(`${field}.${key}`, `must be an array, got ${shapeKind(child)}`);
      child.forEach((entry, index) => checkShape(entry, arraySpec.arrayOf, `${field}.${key}[${index}]`));
      continue;
    }
    if (Array.isArray(child)) throw validation(`${field}.${key}`, `must be an object, got an array`);
    checkShape(child, spec, `${field}.${key}`);
  }
};

const shapeKind = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
};

export const decodeYaml = <T>(data: Buffer, shape: Shape, validate: (value: T) => void): T => {
  if (data.length > MAX_INPUT_BYTES) throw validation("file", "must not exceed 2 MiB");
  const value = safeYAMLToJS<T>(data);
  checkShape(value, shape, "file");
  validate(value);
  return value;
};

export const decodeRequirement = (data: Buffer): RequirementInput => decodeYaml(data, requirementShape, validateRequirementInput);
export const decodeIssue = (data: Buffer): IssueInput => decodeYaml(data, issueShape, validateIssueInput);
export const decodeQuickstart = (data: Buffer): QuickstartInput => decodeYaml(data, quickstartShape, validateQuickstartInput);
export const decodeCandidateSubmission = (data: Buffer): CandidateSubmissionInput => decodeYaml(data, candidateShape, validateCandidateSubmission);
export const decodeVerificationReport = (data: Buffer): VerificationReportInput => decodeYaml(data, verificationShape, validateVerificationReport);

/** Read contract input with a hard cap before parsing or allocating an
 * unbounded buffer. This applies equally to regular files and stdin. */
export const decodeFile = (path: string): Buffer => {
  let fd: number | undefined;
  try {
    fd = path === "-" ? 0 : openSync(path, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      chunks.push(chunk.subarray(0, count));
      if (total > MAX_INPUT_BYTES) throw validation("file", "must not exceed 2 MiB");
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw validation("file", error instanceof Error ? error.message : String(error));
  } finally {
    if (fd !== undefined && fd !== 0) closeSync(fd);
  }
};
export const decodeRequirementFile = (path: string): RequirementInput => decodeRequirement(decodeFile(path));
export const decodeIssueFile = (path: string): IssueInput => decodeIssue(decodeFile(path));
export const decodeQuickstartFile = (path: string): QuickstartInput => decodeQuickstart(decodeFile(path));
export const decodeCandidateSubmissionFile = (path: string): CandidateSubmissionInput => decodeCandidateSubmission(decodeFile(path));
export const decodeVerificationReportFile = (path: string): VerificationReportInput => decodeVerificationReport(decodeFile(path));
