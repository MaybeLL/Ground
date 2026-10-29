export interface PreflightView { label: string; lines: string[] }

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

export function preflightView(value: unknown, required = false): PreflightView | undefined {
  if (value === undefined && !required) return undefined;
  const data = object(value);
  const blockers = Array.isArray(data.blocking) ? data.blocking.map(object) : [];
  const admitted = data.state === 'admitted' && data.code === 'admitted' && blockers.length === 0;
  const label = admitted ? '开工预检：已准入'
    : data.state === 'admitted' ? '开工预检：阻塞（准入状态与检查结果不一致）'
    : data.state === 'preparing' ? '开工预检：准备中 · 不可正式开发'
    : data.state === 'missing' ? '开工预检：待检查 · 不可正式开发'
    : '开工预检：未知 · 不可视为通过';
  const commands = Array.isArray(data.next_commands) ? data.next_commands.filter((command): command is string => typeof command === 'string') : [];
  return { label, lines: [
    label,
    string(data.summary) || (value === undefined ? 'CLI 未提供预检状态；缺失不等于通过。' : ''),
    ...blockers.map(blocker => `阻塞 ${string(blocker.code)}：${string(blocker.detail)}`),
    '这是本次读取的记录，不代表远端最新；开工准入不代表候选验证或交付就绪。',
    ...(commands.length ? ['CLI 补齐路径（仅展示，不自动执行）：', ...commands] : []),
  ].filter(Boolean) };
}
