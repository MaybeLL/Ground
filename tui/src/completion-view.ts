import type { Data } from './protocol.js';
import { clean } from './markdown.js';
const object = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const text = (v: unknown) => clean(String(v ?? '')).replace(/[\r\n\t]/g, ' ');
export function deliveryStatus(status: unknown): string {
  return ({ completed: '已完成', incomplete: '未完成', no_issues: '尚无实施 Issue', ready: '待开发', exploring: '开发中', candidates_available: '待审阅候选', candidate_selected: '准备交付' } as Record<string, string>)[String(status)] ?? text(status);
}
export function completionLines(boardValue: unknown): string[] {
  const board = object(boardValue), view = object(board.completion), record = object(view.record), completion = object(record.completion), release = object(completion.release);
  const verification = object(object(board.selection).current_verification);
  return [
    `交付状态：${deliveryStatus(board.status) || '未记录'}`,
    ...(board.status === 'completed' ? ['下一步：无交付待办。完成仅适用于此 Issue 版本。'] : []),
    ...(view.state === 'reopened' ? [`已重新打开：${text(record.reason)}`] : []),
    ...(record.completion ? [
      `完成时间：${text(completion.completed_at)} · 记录人：${text(object(record.attribution).display_name)}`,
      `目标分支：${text(completion.target_branch)} · 落地提交：${text(completion.landed_commit)}`,
      `合入依据：${text(object(completion.adoption_evidence).description)} · ${text(object(completion.adoption_evidence).reference)}`,
      release.status === 'released' ? `发行：${text(release.version)} · ${text(release.channel)} · ${text(object(release.evidence).reference)}` : `发行不适用：${text(release.reason)}`,
      '证据来源：记录人确认的外部事实；Grounds 未访问或核验这些引用。',
      `独立验证：${text(verification.standing) || '未提供当前 Selection 的验证结论'}。完成不会改变验证结果。`,
    ] : []),
    '登记/历史补录：grounds completion record；查看历史：completion show；撤销完成：completion reopen（须原因与预期版本）。命令均绑定 --issue 与 --issue-version；不会执行合入或发行。',
  ];
}
