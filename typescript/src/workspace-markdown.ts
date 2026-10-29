import { stringify } from "yaml";
import type { ConstraintInput, Decision, IntentLink, IssueInput, IssueRevision, OpenQuestion, RequirementInput, RequirementRevision, TargetInput } from "./domain.js";
import { decisionDetails, validateIssueInput, validateRequirementInput } from "./domain.js";
import { validation } from "./errors.js";
import { safeYAMLToJS } from "./yaml-safe.js";

export type WorkspaceFrontmatter = { type: "requirement" | "issue"; id?: string; version?: number; baseline?: string; target_branch?: IssueInput["target_branch"] };
export interface WorkspaceIssueDraft { input: IssueInput; frontmatter: WorkspaceFrontmatter; baselineExpression: string; questions: string[]; assumptions: string[] }

const frontmatter = (type: "requirement" | "issue", id?: string, version?: number, baseline?: string, target_branch?: IssueInput["target_branch"]): string => {
  const value: WorkspaceFrontmatter = { type, ...(id ? { id } : {}), ...(version ? { version } : {}), ...(baseline ? { baseline } : {}), ...(target_branch ? { target_branch } : {}) };
  return `---\n${stringify(value).trimEnd()}\n---\n\n`;
};

const splitDocument = (text: string, path: string): { metadata: WorkspaceFrontmatter; body: string } => {
  if (!text.startsWith("---\n")) throw validation(path, "must start with YAML frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw validation(path, "has unterminated YAML frontmatter");
  const metadata = safeYAMLToJS<WorkspaceFrontmatter>(Buffer.from(text.slice(4, end)), `${path}.frontmatter`);
  if (!metadata || !["requirement", "issue"].includes(metadata.type) || Object.keys(metadata).some((key) => !["type", "id", "version", "baseline", ...(metadata.type === "issue" ? ["target_branch"] : [])].includes(key))) throw validation(`${path}.frontmatter`, "contains invalid or unknown fields");
  return { metadata, body: text.slice(end + 5).trim() + "\n" };
};

/** Hide fenced code without changing offsets used to slice the original text. */
const outsideFences = (text: string): string => {
  let fence: { char: string; length: number } | undefined;
  return text.replace(/[^\n]*(?:\n|$)/g, (line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return line.replace(/[^\r\n]/g, " ");
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return line.replace(/[^\r\n]/g, " ");
    }
    return line;
  });
};

const sections = (body: string, path: string, allowed: string[]): Map<string, string> => {
  const matches = [...outsideFences(body).matchAll(/^#{1,2} (.+)$/gm)].filter((match) => allowed.includes(match[1].trim()));
  if (!matches.length || matches[0][1].trim() !== "Summary" || body.slice(0, matches[0].index).trim()) throw validation(path, "must start with # Summary");
  const result = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const title = matches[index][1].trim();
    if (result.has(title)) throw validation(path, `duplicate semantic section: ${title}`);
    result.set(title, body.slice(matches[index].index! + matches[index][0].length, matches[index + 1]?.index ?? body.length).trim());
  }
  return result;
};

const withoutGuidanceComments = (text: string): string => {
  const comments = [...outsideFences(text).matchAll(/<!--(?:.|\n)*?-->/g)];
  for (const comment of comments.reverse()) text = text.slice(0, comment.index) + text.slice(comment.index! + comment[0].length);
  return text.trim();
};
const list = (text: string, field: string): string[] => {
  const values: string[] = [];
  for (const line of withoutGuidanceComments(text).split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*[-*] (.+)$/);
    if (!match?.[1]?.trim()) throw validation(field, "entries must be non-empty Markdown bullet items");
    values.push(match[1].trim());
  }
  return values;
};

const referencedList = (text: string, type: IntentLink["type"], field: string): string[] => list(text, field).map((item, index) => {
  const match = new RegExp(`^\\[${type}-([1-9][0-9]*)\\]\\s+(.+)$`).exec(item);
  if (!match) {
    if (item.startsWith(`[${type}-`)) throw validation(`${field}[${index}]`, `must use a complete [${type}-N] label with a 1-based ordinal`);
    return item;
  }
  if (Number(match[1]) !== index + 1) throw validation(field, `${type} labels must match their 1-based list order`);
  return match[2].trim();
});

const intentLinks = (text: string, field: string): IntentLink[] => list(text, field).map((item, index) => {
  const match = /^(outcome|decision)-([1-9][0-9]*)$/.exec(item);
  if (!match) throw validation(`${field}[${index}]`, "must be outcome-N or decision-N using a 1-based ordinal");
  return { type: match[1] as IntentLink["type"], ordinal: Number(match[2]) };
});

const titledBlocks = (text: string, field: string, preserveBody = false): { title: string; body: string }[] => {
  if (!preserveBody) text = withoutGuidanceComments(text);
  const matches = [...outsideFences(text).matchAll(/^### (.+)$/gm)];
  if (withoutGuidanceComments(text.slice(0, matches[0]?.index ?? text.length))) throw validation(field, "entries must use ### headings");
  return matches.map((match, index) => ({ title: match[1].trim(), body: text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length).trim() }));
};

const sub = (body: string, heading: string): string => {
  const match = new RegExp(`^#### ${heading}[ \\t]*$`, "m").exec(outsideFences(body));
  if (!match) return "";
  const rest = body.slice(match.index + match[0].length); const next = /^#### /m.exec(outsideFences(rest));
  return rest.slice(0, next?.index ?? rest.length).trim();
};
const rejectSubsectionPrefix = (body: string, field: string): void => {
  const first = /^#### /m.exec(outsideFences(body));
  if ((first ? body.slice(0, first.index) : body).trim()) throw validation(field, "content must be placed under an allowed #### subsection");
};

const renderDecision = (item: Decision, index: number): string => {
  const { context: _context, ...details } = decisionDetails(item);
  let result = `### [decision-${index + 1}] ${item.statement}`;
  if (item.rationale !== undefined) result += `\n\n#### Rationale\n\n${item.rationale}`;
  if (item.context !== undefined) result += `\n\n#### Context\n\n${item.context}`;
  if (Object.keys(details).length) {
    const yaml = stringify(details).trimEnd();
    let fenceLength = 3;
    for (const match of yaml.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    result += `\n\n#### Details\n\n${fence}yaml\n${yaml}\n${fence}`;
  }
  return result;
};

const parseDecision = (item: { title: string; body: string }, index: number, path: string): Decision => {
  const field = `${path}.Decisions[${index}]`;
  rejectSubsectionPrefix(item.body, field);
  const headings = [...outsideFences(item.body).matchAll(/^#### (.+)$/gm)].map((match) => match[1].trim());
  if (headings.some((heading) => !["Rationale", "Context", "Details"].includes(heading)) || new Set(headings).size !== headings.length) throw validation(field, "contains an unknown or duplicate Decision subsection");
  const label = /^\[decision-([1-9][0-9]*)\]\s+(.+)$/.exec(item.title);
  if (!label && item.title.startsWith("[decision-")) throw validation(field, "must use a complete [decision-N] label with a 1-based ordinal");
  if (label && Number(label[1]) !== index + 1) throw validation(field, "decision labels must match their 1-based heading order");
  let details: Partial<Decision> = {};
  if (headings.includes("Details")) {
    const text = sub(item.body, "Details");
    const match = /^(`{3,}|~{3,})yaml\r?\n([\s\S]*?)\r?\n\1$/.exec(text);
    if (!match || outsideFences(text).trim()) throw validation(`${field}.Details`, "must contain exactly one fenced YAML block");
    const value = safeYAMLToJS<unknown>(Buffer.from(match[2]), `${field}.Details`);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["options", "chosen_option", "trade_offs", "consequences"].includes(key))) throw validation(`${field}.Details`, "contains invalid or unknown fields");
    details = value;
  }
  return { statement: label ? label[2].trim() : item.title, ...details,
    ...(headings.includes("Rationale") ? { rationale: sub(item.body, "Rationale") } : {}),
    ...(headings.includes("Context") ? { context: sub(item.body, "Context") } : {}),
  };
};

export const renderRequirementMarkdown = (input: RequirementInput, id?: string, version?: number): string => {
  const outcomes = input.outcomes.map((item, index) => `- [outcome-${index + 1}] ${item}`).join("\n");
  const decisions = (input.decisions ?? []).map(renderDecision).join("\n\n");
  const questions = (input.open_questions ?? []).map((item) => `### [${item.blocking ? "blocking" : "non-blocking"}] ${item.question}${item.assumption ? `\n\n#### Assumption\n\n${item.assumption}` : ""}`).join("\n\n");
  return frontmatter("requirement", id, version) + `# Summary\n\n${input.summary}\n\n## Context\n\n${input.context ?? ""}\n\n## Outcomes\n\n${outcomes}\n\n## Decisions\n\n${decisions}\n\n## Open Questions\n\n${questions}\n`;
};

export const parseRequirementMarkdown = (text: string, path = "requirement.md"): { input: RequirementInput; frontmatter: WorkspaceFrontmatter } => {
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(outsideFences(text))) throw validation(path, "contains unresolved conflict markers");
  const document = splitDocument(text, path); if (document.metadata.type !== "requirement") throw validation(`${path}.type`, "must equal requirement");
  const value = sections(document.body, path, ["Summary", "Context", "Outcomes", "Decisions", "Open Questions"]);
  const decisions = titledBlocks(value.get("Decisions") ?? "", `${path}.Decisions`, true).map((item, index) => parseDecision(item, index, path));
  const questions: OpenQuestion[] = titledBlocks(value.get("Open Questions") ?? "", `${path}.Open Questions`).map((item) => { const match = item.title.match(/^\[(blocking|non-blocking)\]\s+(.+)$/); if (!match) throw validation(`${path}.Open Questions`, "question titles must start with [blocking] or [non-blocking]"); rejectSubsectionPrefix(item.body, `${path}.Open Questions`); const headings = [...outsideFences(item.body).matchAll(/^#### (.+)$/gm)].map((heading) => heading[1].trim()); if (headings.some((heading) => heading !== "Assumption") || new Set(headings).size !== headings.length) throw validation(`${path}.Open Questions`, "only one #### Assumption subsection is allowed"); const assumption = sub(item.body, "Assumption"); return { question: match[2], blocking: match[1] === "blocking", ...(assumption ? { assumption } : {}) }; });
  const input: RequirementInput = { format: 1, summary: (value.get("Summary") ?? "").trim(), outcomes: referencedList(value.get("Outcomes") ?? "", "outcome", `${path}.Outcomes`), ...(value.get("Context")?.trim() ? { context: value.get("Context")!.trim() } : {}), ...(decisions.length ? { decisions } : {}), ...(questions.length ? { open_questions: questions } : {}) };
  validateRequirementInput(input); return { input, frontmatter: document.metadata };
};

const renderTarget = (target: TargetInput | ConstraintInput): string => `### ${target.statement}\n\n#### Criteria\n\n${target.criteria.map((item) => `- ${item}`).join("\n")}${target.traces_to?.length ? `\n\n#### Traces To\n\n${target.traces_to.map((link) => `- ${link.type}-${link.ordinal}`).join("\n")}` : ""}${target.guidance?.length ? `\n\n#### Guidance\n\n${target.guidance.map((item) => `- ${item}`).join("\n")}` : ""}${"rationale" in target && target.rationale ? `\n\n#### Rationale\n\n${target.rationale}` : ""}`;
export const renderIssueMarkdown = (input: IssueInput, baseline: string, id?: string, version?: number): string => frontmatter("issue", id, version, baseline, input.target_branch) + `# Summary\n\n${input.summary}\n\n## Context\n\n${input.context ?? ""}\n\n## Goals\n\n${input.goals.map(renderTarget).join("\n\n")}\n\n## Constraints\n\n${(input.constraints ?? []).map(renderTarget).join("\n\n")}\n\n## Open Questions\n\n\n\n## Assumptions\n\n\n`;
const parseTargets = (text: string, constraints: boolean): (TargetInput | ConstraintInput)[] => titledBlocks(text, constraints ? "Constraints" : "Goals").map((item) => { const field = constraints ? "Constraints" : "Goals"; rejectSubsectionPrefix(item.body, field); const headings = [...outsideFences(item.body).matchAll(/^#### (.+)$/gm)].map((match) => match[1].trim()); const allowed = constraints ? ["Criteria", "Traces To", "Guidance", "Rationale"] : ["Criteria", "Traces To", "Guidance"]; if (headings.some((heading) => !allowed.includes(heading)) || new Set(headings).size !== headings.length) throw validation(field, "contains an unknown or duplicate subsection"); const criteria = list(sub(item.body, "Criteria"), `${field}.Criteria`); const links = intentLinks(sub(item.body, "Traces To"), `${field}.Traces To`); const guidance = list(sub(item.body, "Guidance"), `${field}.Guidance`); const rationale = sub(item.body, "Rationale"); return { statement: item.title, criteria, ...(links.length ? { traces_to: links } : {}), ...(guidance.length ? { guidance } : {}), ...(constraints && rationale ? { rationale } : {}) }; });

export const parseIssueMarkdown = (text: string, path = "issue.md"): WorkspaceIssueDraft => {
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(outsideFences(text))) throw validation(path, "contains unresolved conflict markers");
  const document = splitDocument(text, path); if (document.metadata.type !== "issue") throw validation(`${path}.type`, "must equal issue");
  if (!document.metadata.baseline) throw validation(`${path}.baseline`, "is required");
  const value = sections(document.body, path, ["Summary", "Context", "Goals", "Constraints", "Open Questions", "Assumptions"]);
  const questionSection = withoutGuidanceComments(value.get("Open Questions") ?? ""); const assumptionSection = withoutGuidanceComments(value.get("Assumptions") ?? ""); const questions = questionSection ? titledBlocks(questionSection, `${path}.Open Questions`).map((item) => item.title) : []; const assumptions = assumptionSection ? titledBlocks(assumptionSection, `${path}.Assumptions`).map((item) => item.title) : [];
  const goalSection = value.get("Goals") ?? ""; const constraintSection = value.get("Constraints") ?? ""; const goals = parseTargets(goalSection, false) as TargetInput[]; const constraints = parseTargets(constraintSection, true) as ConstraintInput[]; if (withoutGuidanceComments(constraintSection) && !constraints.length) throw validation(`${path}.Constraints`, "entries must use ### headings");
  const input: IssueInput = { format: 1, ...(document.metadata.target_branch !== undefined ? { target_branch: document.metadata.target_branch } : {}), summary: (value.get("Summary") ?? "").trim(), goals, ...(value.get("Context")?.trim() ? { context: value.get("Context")!.trim() } : {}), ...(constraints.length ? { constraints } : {}) };
  validateIssueInput(input); return { input, frontmatter: document.metadata, baselineExpression: document.metadata.baseline, questions, assumptions };
};

export const requirementInputFromRevision = (value: RequirementRevision): RequirementInput => ({ format: 1, summary: value.summary, outcomes: value.outcomes, ...(value.context === undefined ? {} : { context: value.context }), ...(value.decisions.length ? { decisions: value.decisions } : {}), ...(value.open_questions?.length ? { open_questions: value.open_questions } : {}) });
export const issueInputFromRevision = (value: IssueRevision): IssueInput => ({ format: 1, ...(value.target_branch ? { target_branch: value.target_branch } : {}), summary: value.summary, goals: value.goals.map(({ statement, criteria, guidance, traces_to }) => ({ statement, criteria: criteria.map((item) => item.statement), ...(traces_to ? { traces_to } : {}), ...(guidance.length ? { guidance } : {}) })), ...(value.context === undefined ? {} : { context: value.context }), ...(value.plan === undefined || value.plan === "" ? {} : { plan: value.plan }), ...(value.constraints.length ? { constraints: value.constraints.map(({ statement, criteria, guidance, rationale, traces_to }) => ({ statement, criteria: criteria.map((item) => item.statement), ...(traces_to ? { traces_to } : {}), ...(guidance.length ? { guidance } : {}), ...(rationale ? { rationale } : {}) })) } : {}) });
