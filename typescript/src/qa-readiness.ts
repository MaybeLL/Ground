import { validation } from './errors.js';
import type { QADraft } from './eval-qa.js';

/** Explicit unfinished declarations only. This is not a semantic quality judge.
 * Draft editing and historical decoding deliberately do not use this gate. */
export function explicitlyUnfinished(text: string, scoring = true): boolean {
  const value = text.normalize('NFKC').trim().replace(/^[\s>*_`-]+|[\s*_`]+$/g, '');
  if (scoring && /^(?:TODO|TBD|FIXME|pending|待补(?:充)?|待定|待确认|未填写)[\s:：。.!！-]*$/iu.test(value)) return true;
  if (/^(?:TODO|TBD|FIXME)(?:\s*[:：-]\s*|\s+)(?:待补(?:充)?|待定|待确认|未填写|placeholder|pending|to\s+be\s+(?:defined|determined|completed)|fill\s+(?:in|this))/iu.test(value)) return true;
  if (/^(?:TODO|TBD|FIXME)(?:\s*[:：-]\s*|\s+)(?:请|需|需要)?\s*(?:补充|补齐|完善|填写)\s*(?:评分(?:标准|依据|规则)|参考答案|权威(?:依据|来源)|审核依据|rubric|authority|scoring\s+(?:criteria|basis))/iu.test(value)) return true;
  return scoring && /(?:^|[，,；;。\n])\s*(?:评分标准|评分依据|权威来源|权威依据|审核依据|参考答案|rubric|authority|scoring\s+(?:basis|criteria))\s*(?:仍|尚|还|暂|is|are)?\s*(?:待补(?:充)?|待定|未(?:完成|核实|填写)|pending|missing|unfinished|TBD|TODO)[\s。.!！]*$/iu.test(value);
}

export function requireReadyQA(qa: QADraft): void {
  if (explicitlyUnfinished(qa.rubric)) throw validation('rubric', 'scoring criteria are explicitly unfinished; complete them before publication');
  for (const field of ['question', 'instructions', 'reference_answer'] as const) {
    // Literal answers such as "TBD" can be legitimate. Only explicit fill-in
    // directives are rejected in content fields; no keyword substring filter.
    if (qa[field] && explicitlyUnfinished(qa[field]!, false)) throw validation(field, 'explicit placeholder must be completed or optional reference answer removed before publication');
  }
}
