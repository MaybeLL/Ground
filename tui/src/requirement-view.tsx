import { completionLines, deliveryStatus } from './completion-view.js';
import React from 'react';
import { Box, Text } from 'ink';
import type { Data } from './protocol.js';
import { clean, renderMarkdown } from './markdown.js';
import { operationHintLines } from './operation-hints.js';
import { preflightView } from './preflight-view.js';

const names: Record<string, string> = { statement: '说明', rationale: '理由', context: '背景', options: '备选方案', chosen_option: '采用方案', trade_offs: '取舍', consequences: '影响', key: '标识', description: '描述', benefits: '收益', costs: '成本', gain: '获得', sacrifice: '代价', reason: '原因', kind: '类型', question: '问题', why: '缘由' };
const value = (v: unknown) => clean(String(v ?? '')).replace(/[\r\n\t]/g, ' ');
const object = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const items = (v: unknown): Data[] => Array.isArray(v) ? v.map(object) : [];
function readable(v: unknown): string {
  if (Array.isArray(v)) return v.map(item => `- ${readable(item)}`).join('\n');
  if (v && typeof v === 'object') return Object.entries(v).map(([key, item]) => `${names[key] ?? key}：${readable(item)}`).join('\n');
  return clean(String(v ?? ''));
}
export const requirementWidth = (width: number) => Math.max(20, Math.min(104, width - 4));
export function requirementLines(requirement: Data, width: number): string[] {
  return renderMarkdown([
    ...(object(requirement.aggregates).completion_status ? [`交付汇总：${deliveryStatus(object(requirement.aggregates).completion_status)}`] : []),
    '## 需求摘要', readable(requirement.summary) || '未记录需求摘要。',
    '## 需求背景', readable(requirement.context) || '未记录需求背景。',
    '## 预期成果', readable(requirement.outcomes) || '未记录预期成果。',
    ...(readable(requirement.decisions) ? ['## 已记录决策', readable(requirement.decisions)] : []),
    ...(readable(requirement.open_questions) ? ['## 待澄清问题', readable(requirement.open_questions)] : []),
    [!readable(requirement.decisions) ? '决策：未记录' : '', !readable(requirement.open_questions) ? '待澄清问题：未记录' : ''].filter(Boolean).join(' · '),
  ].join('\n\n').split('\n'), width, true);
}
export function issueDetailLines(detail: Data, width: number): string[] {
  const issue = object(detail.issue), board = object(detail.board), repository = object(detail.repository), baseline = object(detail.baseline);
  const selection = object(board.selection);
  const sections = (kind: 'goals' | 'constraints', title: string) => items(issue[kind]).flatMap((entry, index) => [
    `### ${title} ${index + 1} · ${value(entry.statement)}`,
    ...items(entry.criteria).map((criterion, number) => `${index + 1}.${number + 1} ${value(criterion.statement)}`),
  ]);
  return renderMarkdown([
    `绑定 Requirement v${value(object(issue.requirement).version) || '未知'} · Issue ${value(issue.id)} v${value(issue.version)}`,
    ...(preflightView(board.preflight, !!issue.target_branch)?.lines.map(clean) ?? []),
    '## Issue 摘要', readable(issue.summary) || '未记录 Issue 摘要。',
    `仓库：${value(repository.canonical_remote) || '未记录'}`,
    `Baseline：${value(baseline.git_oid) || '未记录'}`,
    `交付状态：${deliveryStatus(board.status) || '未记录'} · Candidate ${value(board.candidate_count) || '0'} 个 · 开放 DevRun ${value(board.open_dev_run_count) || '0'} 个`,
    ...(object(board.completion).record ? completionLines(board).slice(1, -1) : []),
    `当前 Selection：${value(selection.candidate_id) || '未选择'}`,
    '## Issue 背景', readable(issue.context) || '未记录背景。',
    '## 目标', ...sections('goals', '目标'),
    '## 约束', ...sections('constraints', '约束'),
    completionLines(board).at(-1)!,
    Number(board.candidate_count) > 0 ? '按 Enter 查看 Candidate。' : '暂无 Candidate；仍可阅读上方契约。',
  ].join('\n\n').split('\n'), width, true);
}
export function requirementLayout(height: number, hintLines: number, issueList = false, notice = false) {
  return Math.max(1, height - 5 - hintLines - (height > 10 ? 1 : 0) - (issueList ? 1 : 0) - (notice ? 1 : 0));
}
export function RequirementView({ requirement, activeTab, rows, total, query, row, requirementScroll, issueScroll, issueDetail, busy, notice, width, height }: {
  requirement: Data; activeTab: 'requirement' | 'issues'; rows: Data[]; total: number; query: string; row: number;
  requirementScroll: number; issueScroll: number; issueDetail?: Data; busy: boolean; notice: string; width: number; height: number;
}) {
  const detail = activeTab === 'issues' && issueDetail;
  const list = activeTab === 'issues' && !detail;
  const hasCandidates = Boolean(detail) && Number(object(issueDetail?.board).candidate_count) > 0;
  const contentWidth = requirementWidth(width);
  const lines = activeTab === 'requirement' ? requirementLines(requirement, contentWidth) : detail ? issueDetailLines(issueDetail, contentWidth) : [];
  const compact = height <= 10;
  const hints = compact ? [
    list ? '↑↓ 选择 · Enter 详情' : detail ? hasCandidates ? 'Enter 候选 · Esc 列表' : 'Esc 列表 · ↑↓ 滚动' : 'Tab 页签 · Esc 搜索',
    list ? 'Tab 页签 · Esc 需求 · ? 帮助' : detail ? 'Tab 页签 · ↑↓ 滚动 · ? 帮助' : '↑↓ 滚动 · ? 帮助',
  ] : operationHintLines([
    'Tab 切换 Requirement/Issue', detail ? 'Esc 返回 Issue 列表' : list ? 'Esc 返回 Requirement' : 'Esc 返回需求搜索',
    list ? '↑↓ 选择 · Enter 查看详情' : '↑↓/PgUp/PgDn 滚动',
    ...(list ? ['输入标题/ID 筛选 · Backspace 删除'] : hasCandidates ? ['Enter 查看 Candidate'] : []),
    'Ctrl+R 刷新', '? 帮助', 'Ctrl+C 退出',
  ], width, Math.max(1, Math.min(3, height - 7)));
  const status = notice || (busy ? '正在读取…' : '');
  const bodyHeight = requirementLayout(height, hints.length, list, Boolean(status));
  const scroll = Math.max(0, Math.min(activeTab === 'requirement' ? requirementScroll : issueScroll, Math.max(0, lines.length - bodyHeight)));
  const first = Math.max(0, row - bodyHeight + 1);
  const currentVersion = `当前需求 v${value(requirement.version)} · ${value(requirement.summary)}`;
  const currentId = `ID ${value(requirement.id)}`;
  const tabText = <Text wrap="truncate"><Text bold={activeTab === 'requirement'} underline={activeTab === 'requirement'} color={process.env.NO_COLOR === undefined && activeTab === 'requirement' ? 'green' : undefined}>{`${activeTab === 'requirement' ? '▸' : ' '} Requirement`}</Text><Text dimColor>  │  </Text><Text bold={activeTab === 'issues'} underline={activeTab === 'issues'} color={process.env.NO_COLOR === undefined && activeTab === 'issues' ? 'green' : undefined}>{`${activeTab === 'issues' ? '▸' : ' '} Issue (${total})`}</Text></Text>;
  return <Box flexDirection="column" width={width} height={height - 1}>
    {!compact && <Text bold color={process.env.NO_COLOR === undefined ? 'cyan' : undefined} wrap="truncate">有据 Grounds · 需求开发</Text>}
    <Text wrap="truncate">{currentVersion}</Text>
    <Text wrap="truncate">{currentId}</Text>
    {tabText}
    <Box flexDirection="column" alignSelf="center" width={contentWidth}>
      <Text bold wrap="truncate">{activeTab === 'requirement' ? `需求原文 · ${Math.min(scroll + 1, Math.max(1, lines.length))}/${Math.max(1, lines.length)} 行` : detail ? `Issue 详情 · v${value(object(issueDetail.issue).version)} · ${value(object(issueDetail.issue).summary)}` : `关联 Issue · ${total} 个${query ? ` · 匹配 ${rows.length} 项` : ''}`}</Text>
      {list && <Text wrap="truncate">{query ? `筛选：${value(query)}` : '输入标题或 ID 筛选'}</Text>}
      <Box flexDirection="column" height={bodyHeight} overflow="hidden">
        {list ? rows.length ? rows.slice(first, first + bodyHeight).map((item, index) => <Text key={value(item.resource_id)} inverse={first + index === row} wrap="truncate">{first + index === row ? '› ' : '  '}v{value(item.version)}{item.bound_to_selected_version === false ? ` · 绑定需求 v${value(item.requirementVersion)}` : ''}{object(item.board).status ? ` · ${deliveryStatus(object(item.board).status)}` : ''} · {value(item.label)}</Text>) : <Text>{busy ? '正在读取关联 Issue…' : total ? '没有匹配的 Issue。' : '该需求尚无关联 Issue。'}</Text>
          : lines.slice(scroll, scroll + bodyHeight).map((line, index) => <Text key={index} wrap="truncate">{line || ' '}</Text>)}
      </Box>
      {status && <Text color="yellow" wrap="truncate">{value(status)}</Text>}
    </Box>
    <Box flexGrow={1} />
    <Box flexDirection="column">{hints.map((line, index) => <Text key={index} bold color={process.env.NO_COLOR === undefined ? 'green' : undefined} wrap="truncate">{line}</Text>)}</Box>
  </Box>;
}
