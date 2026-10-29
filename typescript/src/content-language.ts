import type { CandidateSubmissionInput, IssueInput, RequirementInput, VerificationReportInput } from "./domain.js";
import { validation } from "./errors.js";
import type { QualityReviewReportInput } from "./quality-review.js";
import type { Warning } from "./module.js";

export interface ContentLanguagePolicy { language: "zh-CN"; overrideReason?: string }
export interface ProseField { path: string; value: string | undefined }

/** Content language is opt-in so existing English projects retain their write behavior. */
export const contentLanguagePolicy = (language: string | undefined, reason: string | undefined): ContentLanguagePolicy | undefined => {
  if (language === undefined) {
    if (reason !== undefined) throw validation("language-override-reason", "requires --content-language zh-CN");
    return undefined;
  }
  if (language !== "zh-CN") throw validation("content-language", "currently only zh-CN is supported");
  if (reason !== undefined && (!reason.trim() || [...reason].length > 1024)) throw validation("language-override-reason", "must contain 1–1024 characters");
  return { language, ...(reason !== undefined ? { overrideReason: reason.trim() } : {}) };
};

const field = (path: string, value: string | undefined): ProseField => ({ path, value });

export const requirementProse = (input: RequirementInput, prefix = "requirement"): ProseField[] => [
  field(`${prefix}.summary`, input.summary), field(`${prefix}.context`, input.context),
  ...input.outcomes.map((value, index) => field(`${prefix}.outcomes[${index}]`, value)),
  ...(input.decisions ?? []).flatMap((decision, index) => {
    const path = `${prefix}.decisions[${index}]`;
    return [field(`${path}.statement`, decision.statement), field(`${path}.rationale`, decision.rationale), field(`${path}.context`, decision.context),
      ...(decision.options ?? []).flatMap((option, optionIndex) => {
        const optionPath = `${path}.options[${optionIndex}]`;
        return [field(`${optionPath}.description`, option.description),
          ...(option.benefits ?? []).map((value, i) => field(`${optionPath}.benefits[${i}]`, value)),
          ...(option.costs ?? []).map((value, i) => field(`${optionPath}.costs[${i}]`, value))];
      }),
      ...(decision.trade_offs ?? []).flatMap((tradeOff, i) => [field(`${path}.trade_offs[${i}].gain`, tradeOff.gain), field(`${path}.trade_offs[${i}].sacrifice`, tradeOff.sacrifice), field(`${path}.trade_offs[${i}].reason`, tradeOff.reason)]),
      ...(decision.consequences ?? []).map((consequence, i) => field(`${path}.consequences[${i}].statement`, consequence.statement))];
  }),
  ...(input.open_questions ?? []).flatMap((question, index) => [field(`${prefix}.open_questions[${index}].question`, question.question), field(`${prefix}.open_questions[${index}].assumption`, question.assumption)]),
];

export const issueProse = (input: IssueInput, prefix = "issue"): ProseField[] => [
  field(`${prefix}.summary`, input.summary), field(`${prefix}.context`, input.context),
  // Plan is human-authored prose too. Diagram fences inside it are stripped by
  // the caller's fence handling, so only the surrounding text is checked.
  ...(input.plan === undefined ? [] : [field(`${prefix}.plan`, input.plan)]),
  ...(["goals", "constraints"] as const).flatMap(kind => (input[kind] ?? []).flatMap((target, index) => {
    const path = `${prefix}.${kind}[${index}]`;
    return [field(`${path}.statement`, target.statement),
      ...target.criteria.map((value, i) => field(`${path}.criteria[${i}]`, value)),
      ...(target.guidance ?? []).map((value, i) => field(`${path}.guidance[${i}]`, value)),
      ...(kind === "constraints" ? [field(`${path}.rationale`, (target as { rationale?: string }).rationale)] : [])];
  })),
];

export const candidateProse = (input: CandidateSubmissionInput): ProseField[] => [
  field("submission.explanation", input.explanation),
  ...input.claims.flatMap((claim, index) => [field(`submission.claims[${index}].explanation`, claim.explanation),
    ...claim.criteria.flatMap((criterion, i) => [field(`submission.claims[${index}].criteria[${i}].explanation`, criterion.explanation),
      field(`submission.claims[${index}].criteria[${i}].self_verification.explanation`, criterion.self_verification?.explanation),
      field(`submission.claims[${index}].criteria[${i}].self_verification.method`, criterion.self_verification?.method)])]),
  ...(input.format === "patchledger.candidate-submission/v2" ? input.change_rationales.flatMap((rationale, index) => [
    field(`submission.change_rationales[${index}].rationale`, rationale.rationale),
    ...rationale.alternatives.flatMap((alternative, i) => [field(`submission.change_rationales[${index}].alternatives[${i}].approach`, alternative.approach), field(`submission.change_rationales[${index}].alternatives[${i}].rejected_because`, alternative.rejected_because)]),
    ...rationale.risks.map((value, i) => field(`submission.change_rationales[${index}].risks[${i}]`, value)),
  ]) : []),
];

export const verificationProse = (report: VerificationReportInput): ProseField[] => report.assessments.flatMap((assessment, index) =>
  assessment.criteria.flatMap((criterion, i) => [
    field(`report.assessments[${index}].criteria[${i}].independent.explanation`, criterion.independent.explanation),
    field(`report.assessments[${index}].criteria[${i}].reconciliation.explanation`, criterion.reconciliation.explanation),
    field(`report.assessments[${index}].criteria[${i}].final.explanation`, criterion.final.explanation),
  ]));

export const qualityProse = (report: QualityReviewReportInput): ProseField[] => report.dimensions.flatMap((dimension, index) => {
  const prefix = `quality.dimensions[${index}]`;
  return [
    field(`${prefix}.independent.explanation`, dimension.independent.explanation),
    ...dimension.independent.findings.map((finding, i) => field(`${prefix}.independent.findings[${i}].explanation`, finding.explanation)),
    field(`${prefix}.reconciliation.explanation`, dimension.reconciliation.explanation),
    field(`${prefix}.final.explanation`, dimension.final.explanation),
    ...dimension.final.findings.map((finding, i) => field(`${prefix}.final.findings[${i}].explanation`, finding.explanation)),
  ];
});

const proseCounts = (value: string): { words: number; latinLetters: number; han: number; todo: boolean } => {
  const prose = value
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+|(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, " ");
  return {
    words: (prose.match(/[A-Za-z]{3,}/g) ?? []).length,
    latinLetters: (prose.match(/[A-Za-z]/g) ?? []).length,
    han: (prose.match(/\p{Script=Han}/gu) ?? []).length,
    todo: /^\s*TODO\s*:/i.test(prose),
  };
};

/** A deliberately conservative signal, not a translation or semantic language classifier. */
export const clearlyEnglishProse = (value: string): boolean => {
  const { words, latinLetters, han, todo } = proseCounts(value);
  return todo || (han === 0 && words >= 3 && latinLetters >= 18)
    || (words >= 8 && latinLetters >= 45 && latinLetters > han * 5);
};

export const checkContentLanguage = (fields: ProseField[], policy: ContentLanguagePolicy | undefined): Warning[] => {
  if (!policy) return [];
  const flagged = new Set(fields.filter(item => item.value && clearlyEnglishProse(item.value)).map(item => item.path));
  const shortEnglish = fields.filter(item => {
    if (!item.value) return false;
    const { words, latinLetters, han } = proseCounts(item.value);
    return han === 0 && words >= 2 && latinLetters >= 10;
  });
  if (shortEnglish.length >= 3 && shortEnglish.reduce((sum, item) => sum + proseCounts(item.value!).latinLetters, 0) >= 50) {
    for (const item of shortEnglish) flagged.add(item.path);
  }
  if (!flagged.size) return [];
  const paths = [...flagged];
  const locations = paths.slice(0, 8).join(", ") + (paths.length > 8 ? ` 等 ${paths.length} 处` : "");
  if (!policy.overrideReason) throw validation("content_language", `以下面向人的字段疑似以英文为主：${locations}。请改为中文，或用 --language-override-reason <理由> 明确豁免。`);
  return [{ code: "CONTENT_LANGUAGE_OVERRIDE", message: `中文内容检查豁免：${locations}；理由：${policy.overrideReason}` }];
};
