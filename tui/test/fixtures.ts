import type { Data, Method } from '../src/protocol.js';
export const issue = { id: 'i', version: 1, summary: '输入校验', requirement: { id: 'r', version: 1 }, goals: [{ id: 'g', statement: '校验参数', criteria: [{ id: 'ac', statement: '拒绝非法参数' }] }], constraints: [{ id: 'h', statement: '保持兼容', criteria: [{ id: 'ac', statement: '兼容原调用' }] }] };
export const requirement = { id: 'r', version: 1, summary: '完整需求', context: '# 背景标题\n\n正文说明', outcomes: ['输入应合法'], decisions: [], open_questions: [] };
export const set = { count: 1, digest: 'set1', standing: 'qualified', verdict_counts: { qualified: 1, rejected: 0, inconclusive: 0 }, reports_included: false };
export const entry = { verification_id: 'v', candidate_id: 'c', overall_verdict: 'qualified', created_at: '2026-09-14T00:00:00Z', attribution: { kind: 'human' } };
export const candidate = { candidate_id: 'c', issue: { id: 'i', version: 1 }, submission_explanation: '# 实现说明\n\n增加边界校验', file_manifest: [{ path_bytes: 'YQ==', display_path: 'a.ts', change: 'modify' }], file_count: 1, manifest_digest: 'manifest', result_tree_oid: 'tree', standing: 'unverified', verification_count: 0, verification_digest: 'set0', is_selected: false };
export const trace = { candidate: { candidate_id: 'c' }, artifact: { result_tree_oid: 'tree' }, contract: { issue, requirement },
  change_index: { change_units: [{ change_unit_id: 'unit', display_path: 'a.ts', kind: 'hunk' }] },
  submission: { change_rationales: [{ change_refs: ['unit'], rationale: '# 原因\n\n准确理由' }], claims: [
    { target_type: 'goal', target_id: 'g', explanation: '目标声明', criteria: [{ criterion_id: 'ac', explanation: '目标标准声明', evidence: [] }] },
    { target_type: 'constraint', target_id: 'h', explanation: '约束声明', criteria: [{ criterion_id: 'ac', explanation: '约束标准声明', evidence: [] }] },
  ] }, verification_set: set };
export const report = { ...entry, report: { candidate_id: 'c', result_tree_oid: 'tree', assessments: [{ target_type: 'goal', target_id: 'g', criteria: [{ criterion_id: 'ac',
  independent: { verdict: 'qualified', explanation: '# 独立结论\n\n独立观察', evidence: [] }, reconciliation: { claim_relation: 'corroborated', explanation: '核对作者' }, final: { verdict: 'qualified', explanation: '最终结论' },
}] }] } };
export function fixture(method: Method, args: string[] = []): Data {
  switch (method) {
    case 'requirements': return { resources: [{ resource_id: 'r', label: '完整需求', version: 1 }] };
    case 'requirement': return { requirement, issues: [{ issue, bound_to_selected_version: true }], aggregates: { issue_count: 1 } };
    case 'issue': return { issue, requirement, board: {}, repository: { id: 'repo' }, baseline: { git_oid: 'baseline' } };
    case 'candidates': return { resources: [{ resource_id: 'c', label: '方案 A' }, { resource_id: 'c2', label: '方案 B' }] };
    case 'candidate': return { candidate: { ...candidate, candidate_id: args[0] ?? 'c' } };
    case 'review': return { trace: { ...trace, candidate: { candidate_id: args[0] ?? 'c' } } };
    case 'verifications': return { candidate_id: 'c', verification_set: set, verifications: [entry] };
    case 'verification': return report;
    case 'devruns': return { resources: [] };
    case 'compare': return { issue: { id: 'i', version: 1 }, candidates: args.slice(0, 2).map(candidate_id => ({ candidate_id, submission_explanation: { preview: '比较说明', truncated: true }, changed_files_count: 1 })) };
    default: throw new Error(`Unexpected fixture method ${method}`);
  }
}
