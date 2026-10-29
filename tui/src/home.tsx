import React from 'react';
import { Box, Text } from 'ink';
import type { Data } from './protocol.js';
import { record } from './pages.js';
import { clean } from './markdown.js';
import { operationHintLines } from './operation-hints.js';
const value = (v: unknown) => clean(String(v ?? '')).replace(/[\r\n\t]/g, ' ');
export const FULL_GROUNDS_LOGO = [
  '  ██████╗ ██████╗  ██████╗ ██╗   ██╗███╗   ██╗██████╗ ███████╗',
  ' ██╔════╝ ██╔══██╗██╔═══██╗██║   ██║████╗  ██║██╔══██╗██╔════╝',
  ' ██║  ███╗██████╔╝██║   ██║██║   ██║██╔██╗ ██║██║  ██║███████╗',
  ' ╚██████╔╝██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║██████╔╝███████║',
  '  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═════╝ ╚══════╝',
] as const;
type BrandTier = 'full' | 'compact' | 'hidden';
const brandTier = (parent: string | undefined, width: number, height: number): BrandTier => {
  if (parent || width < 60 || height < 22) return 'hidden';
  return width >= 94 && height >= 28 ? 'full' : 'compact';
};
export function BrandIdentity({ tier }: { tier: BrandTier }) {
  if (tier === 'hidden') return null;
  const color = process.env.NO_COLOR === undefined ? 'cyan' : undefined;
  if (tier === 'compact') {
    return <Box flexShrink={0} marginBottom={1} justifyContent="center"><Text bold color={color}>有据  G R O U N D S</Text></Box>;
  }
  return <Box flexShrink={0} marginBottom={1} alignItems="center" flexDirection="column">
    <Text color={color}>{FULL_GROUNDS_LOGO.join('\n')}</Text>
    <Text bold>有 据</Text>
    <Text dimColor>可信交付 · Know How. Know Why.</Text>
  </Box>;
}
export function searchIssues(items: Data[], query: string): Data[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => terms.every(term => `${value(item.label)} ${value(item.resource_id)}`.toLocaleLowerCase().includes(term)));
}
export function weekIssues(items: Data[], now = Date.now()): Data[] {
  return items.filter(item => { const at = Date.parse(String(record(item.last_activity).occurred_at ?? '')); return at <= now && at >= now - 7 * 86400000; });
}
export function SearchHome({ homeAvailable = false, evalAvailable = false, kind = 'issues', parent, items, results, query, row, recent, busy, notice, width, height }: { homeAvailable?: boolean; evalAvailable?: boolean; kind?: 'requirements' | 'issues'; parent?: string; items: Data[]; results: Data[]; query: string; row: number; recent: boolean; busy: boolean; notice: string; width: number; height: number }) {
  const entity = kind === 'requirements' ? 'Requirement' : 'Issue';
  const activityKnown = items.length === 0 || items.every(item => Number.isFinite(Date.parse(String(record(item.last_activity).occurred_at ?? ''))));
  const week = weekIssues(items), compactLayout = height < 22;
  const recentHeight = compactLayout ? 2 : 5;
  const branding = brandTier(parent, width, height);
  const brandHeight = branding === 'full' ? 8 : branding === 'compact' ? 2 : 0;
  const hints = operationHintLines([
    ...(homeAvailable ? ['Ctrl+G 返回首页'] : []), '输入标题/ID 搜索', 'Backspace 删除', '↑↓ 选结果', ...(results.length ? ['Enter 打开'] : []), 'Tab 最近一周/搜索',
    ...(evalAvailable ? ['Ctrl+E 评测工作台'] : []), 'Esc 清空/返回', 'Ctrl+T 切换需求/任务', 'Ctrl+R 刷新', '? 全部操作', 'Ctrl+C 退出',
  ], width, Math.max(1, Math.min(4, height - 10)));
  const resultHeight = Math.max(1, Math.min(7, height - recentHeight - 10 - brandHeight - (hints.length - 1)));
  const start = Math.max(0, row - resultHeight + 1);
  const cardWidth = Math.min(width - 4, 84);
  return <Box flexDirection="column" width={width} height={height - 1}>
    <Text bold>有据 Grounds · {kind === 'requirements' ? '查找需求（Requirement）' : '查找交付任务（Issue）'}</Text>
    <Box height={recentHeight} justifyContent="flex-end"><Box width={Math.min(width - 2, 58)} flexDirection="column">
      <Text bold inverse={recent}>{activityKnown ? `最近一周有活动 · ${week.length} 项 · Tab 切换` : '最近一周 · 活动时间不可用'}</Text>
      {!compactLayout && (week.length ? week.slice(recent ? start : 0, (recent ? start : 0) + 3).map((item, i) => <Text key={String(item.resource_id)} inverse={recent && start + i === row} wrap="truncate">{recent && start + i === row ? '› ' : '  '}{value(item.label)}</Text>) : <Text dimColor>{activityKnown ? '最近一周暂无活动' : '当前接口未提供完整活动时间'}</Text>)}
    </Box></Box>
    <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column">
      <BrandIdentity tier={branding} />
      <Box width={cardWidth} flexDirection="column">
        <Text bold>{parent ? `需求：${value(parent)} · 选择关联 Issue` : kind === 'requirements' ? '找到需求，阅读需求详情' : '找到任务，开始审阅'}</Text>
        <Box borderStyle="round" paddingX={1}><Text wrap="truncate">{query || (recent ? '按 Tab 返回搜索' : `输入标题关键词或 ${entity} ID`)}{!recent && '▏'}</Text></Box>
        <Text dimColor>{busy ? '正在读取…' : recent ? '最近一周有活动的需求' : query ? `匹配 ${results.length} 项 · 标题 / ID 包含全部关键词` : `可搜索 ${items.length} 项 · 下方为可用记录`}</Text>
        <Box height={resultHeight} flexDirection="column">{!busy && !results.length ? <Text>{query ? '没有匹配结果，试试更短的关键词。' : recent ? activityKnown ? '最近一周暂无活动；Tab 返回搜索。' : '活动时间不可用；Tab 返回搜索全部记录。' : `暂无${parent ? '关联' : ''} ${entity}。`}</Text> : results.slice(start, start + resultHeight).map((item, i) => <Text key={String(item.resource_id)} inverse={start + i === row} wrap="truncate">{start + i === row ? '› ' : '  '}{value(item.label)} · v{value(item.version)}</Text>)}</Box>
      </Box>
    </Box>
    <Text color="yellow" wrap="truncate">{notice || `搜索 ${entity} 标题和 ID · Ctrl+T 切换 Requirement / Issue`}</Text>
    <Box flexDirection="column">{hints.map((line, index) => <Text key={index} bold color={process.env.NO_COLOR === undefined ? 'green' : undefined} wrap="truncate">{line}</Text>)}</Box>
  </Box>;
}
