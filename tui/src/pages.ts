import { completionLines, deliveryStatus } from './completion-view.js';
import { candidateHistoryLines } from './candidate-history.js';
import type { Reader } from './client.js';
import { ClientError, type Data } from './protocol.js';
import { preflightView } from './preflight-view.js';

export const record = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
export const array = (v: unknown): Data[] => Array.isArray(v) ? v.map(record) : [];
const s = (v: unknown): string => v === undefined || v === null ? 'unknown' : String(v);
/** Verification mode and, for ultra, the verdict of the separately signed code-quality part. Full quality findings stay in the CLI/Review output. */
export const verificationMode = (v: Data): string => v.mode === 'ultra' ? `ultra（质量评审 ${s(v.quality_verdict ?? record(v.quality).overall_verdict)}）` : 'normal';
const labels: Record<string, string> = { summary: '标题', statement: '说明', explanation: '解释', rationale: '作者理由', source: '来源',
  claims: 'Claims（作者声明）', criteria: 'Criteria', goals: 'Goals', constraints: 'Constraints', outcomes: 'Outcomes',
  development: '受管开发路线', branch: '本地分支', workspace_id: '路线 ID', local_worktree: '本机工作目录（本次观察）', current_head: '当前提交验收状态', head: '本次观察到的 HEAD', artifact_restoration: '固定工件恢复范围', source_history: '原始来源历史', initial_base_commit: '首次开发起点', definition_commit: '契约定义参考提交', base_commit: '候选逻辑起点', source_commit: '归档来源提交', source_parents: '原始父提交', parents: '父提交', commit: '固定来源提交', working_tree_dirty: '活动文件存在未保存改动', git_operation_in_progress: 'Git 操作尚未完成', continuation: '作者继续策略', active_dev_run_id: '当前开发轮次', owner_phase: '目录恢复状态',
  standing: 'Standing', is_selected: '已选择（不等于合入）', attribution: '作者', created_at: '记录时间',
  risk: '风险', risks: '风险', alternatives: '替代方案', relation: '关联类型', preview: '预览', truncated: '已截断',
  unknown: '未知', display_path: '显示路径', old_range: '旧侧范围', new_range: '新侧范围', verdict: '判定',
  mode: '验收模式', quality_verdict: '质量评审结论', quality_attribution: '质量评审者', quality: '代码质量评审（ultra）', evidence: 'Evidence', independent: '独立判断', reconciliation: '核对判断', final: '最终判断', next_action: 'CLI 建议（只读）' };

export function describe(value: unknown, indent = ''): string[] {
  if (value === undefined || value === null) return [indent + 'unknown'];
  if (typeof value !== 'object') return s(value).split('\n').map(line => indent + line);
  if (Array.isArray(value)) return value.length ? value.flatMap((v, i) => [indent + `${i + 1}.`, ...describe(v, indent + '  ')]) : [indent + '无记录'];
  return Object.entries(record(value)).flatMap(([key, v]) => {
    if (['result_type', 'command', 'path_bytes', 'old_path_bytes'].includes(key)) return [];
    const label = labels[key] ?? key;
    if (typeof v === 'string' && v.includes('\n')) return ['', `**${label}**`, '', ...v.split('\n'), ''];
    return typeof v === 'object' && v !== null ? [indent + label, ...describe(v, indent + '  ')] : [indent + label + ': ' + s(v)];
  });
}

export type Kind = 'home' | 'requirement' | 'issue' | 'candidates' | 'devruns' | 'devrun' | 'candidate' | 'compare' | 'review' | 'verifications' | 'verification';
export interface Route { kind: Kind; id?: string; version?: number; issueId?: string; cursor?: string; pair?: string[]; set?: Data; tree?: string; entry?: Data }
export interface Row { id: string; label: string; lines: string[]; route?: Route }
export interface Page { title: string; lines: string[]; rows: Row[]; next?: Route; note?: string }
const title = (v: Data) => `${s(v.summary)} · v${s(v.version)} · ${s(v.id)}`;
const sameSet = (a: Data, b: Data) => a.digest === b.digest && a.count === b.count && a.standing === b.standing
  && ['qualified', 'rejected', 'inconclusive'].every(k => record(a.verdict_counts)[k] === record(b.verdict_counts)[k]);
const timestamp = (v: unknown) => s(v).replace(/\.(\d+)Z$/, (_, digits: string) => { const t = digits.replace(/0+$/, ''); return t ? `.${t}Z` : 'Z'; });
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object'
  ? '{' + Object.entries(record(v)).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}' : JSON.stringify(v);

export async function loadPage(reader: Reader, route: Route, signal: AbortSignal): Promise<Page> {
  const warnings: string[] = [];
  const q = async (method: Parameters<Reader['query']>[0], args: string[] = []) => {
    const data = await reader.query(method, args, signal);
    warnings.push(...array(data.warnings).map(w => `警告 ${s(w.code)}: ${s(w.message)}`));
    return data;
  };
  const id = route.id ?? '';
  const page = (title: string, lines: string[], rows: Row[] = [], next?: Route): Page => ({ title, lines: [...warnings, ...lines], rows, next });
  const next = (cursor: unknown): Route | undefined => {
    if (!cursor) return undefined;
    if (typeof cursor !== 'string' || cursor === route.cursor) throw new ClientError('PROTOCOL_ERROR', '分页游标没有前进');
    return { ...route, cursor };
  };
  switch (route.kind) {
    case 'home': {
      const data = await q('requirements');
      return page('Requirement · 全部账本', ['按标题或 ID 搜索；g 直接打开历史 Candidate。'], array(data.resources).map(r => ({ id: s(r.resource_id), label: `${s(r.label)} · v${s(r.version)}`, lines: describe(r), route: { kind: 'requirement', id: s(r.resource_id) } })));
    }
    case 'requirement': {
      let data: Data;
      let reset = false;
      try { data = await q('requirement', [id, ...(route.cursor ? ['--issues-cursor', route.cursor] : [])]); }
      catch (e) {
        if (!route.cursor || !(e instanceof ClientError) || e.code !== 'VALIDATION_ERROR') throw e;
        data = await q('requirement', [id]);
        if (record(data.requirement).version === route.version) throw e;
        reset = true;
      }
      const requirement = record(data.requirement);
      const rows = array(data.issues).map(r => ({ id: s(record(r.issue).id), label: title(record(r.issue)), lines: describe(r), route: { kind: 'issue' as const, id: s(record(r.issue).id) } }));
      const more = data.issues_next_cursor;
      if (data.issues_omitted && (!more || !rows.length)) throw new ClientError('PROTOCOL_ERROR', 'Issue 分页不完整');
      const result = page('Requirement · ' + title(requirement), [...describe(requirement), '', `交付汇总：${deliveryStatus(record(data.aggregates).completion_status)}`, '聚合（最近响应；各页不可相加）', ...describe(data.aggregates)], rows,
        more ? { ...route, version: Number(requirement.version), cursor: String(more) } : undefined);
      if (more && more === route.cursor) throw new ClientError('PROTOCOL_ERROR', '游标重复');
      if (reset) result.note = 'Requirement 版本变化，已重新读取首页';
      return result;
    }
    case 'issue': {
      const d = await q('issue', [id]); const issue = record(d.issue);
      return page('Issue · ' + title(issue), [...completionLines(d.board), ...(preflightView(record(d.board).preflight, !!issue.target_branch)?.lines ?? []), ...describe(d), '', '只读浏览；Selection 不代表合入。'], [
        { id: 'candidates', label: `Candidate · 固定 v${s(issue.version)}`, lines: ['Enter 查看该版本 Candidate'], route: { kind: 'candidates', id, version: Number(issue.version) } },
        { id: 'devruns', label: 'DevRun · 全部版本', lines: ['包含历史版本，不等于当前 board 的计数。'], route: { kind: 'devruns', id } },
      ]);
    }
    case 'candidates': {
      const d = await q('candidates', ['--issue', id, '--issue-version', String(route.version)]);
      return page(`Candidate · Issue ${id} v${route.version}`, ['Space 标记两个候选，c 比较；Enter 查看详情。'], array(d.resources).map(r => ({ id: s(r.resource_id), label: `${s(r.label)} · ${s(r.state)}${r.is_selected ? ' · 已选择' : ''}`, lines: describe(r), route: { kind: 'candidate', id: s(r.resource_id) } })));
    }
    case 'devruns': {
      const d = await q('devruns', ['--issue', id]);
      return page('DevRun · 全部 Issue 版本', ['详情显示所属版本；open 不证明 Agent 正在运行。'], array(d.resources).map(r => ({ id: s(r.resource_id), label: `${s(r.state)} · ${s(r.resource_id)}`, lines: describe(r), route: { kind: 'devrun', id: s(r.resource_id) } })));
    }
    case 'devrun': { const d = await q('devrun', [id]); return page('DevRun · ' + id, [...(preflightView(d.preflight, !!d.development)?.lines ?? []), ...(d.development ? ['当前验收状态只指本次观察到的 HEAD 提交；未保存文件和未完成 Git 操作不属于此前报告覆盖。未知时不能当作已就绪。', '归档后作者默认暂停；明确并行继续时另记策略。'] : []), ...describe(d)]); }
    case 'candidate': {
      const d = await q('candidate', [id, ...(route.cursor ? ['--manifest-cursor', route.cursor] : [])]); const c = record(d.candidate);
      if (c.candidate_id !== id || (route.tree && c.manifest_digest !== route.tree)) throw new ClientError('PROTOCOL_ERROR', 'Candidate manifest 身份变化');
      const { file_manifest, verifications, ...detail } = c;
      const rows: Row[] = [{ id: 'review', label: '打开 Review / Verification', lines: ['历史契约、作者理由、验证报告'], route: { kind: 'review', id } },
        ...array(file_manifest).map(f => ({ id: s(f.path_bytes), label: `${s(f.display_path)} · ${s(f.change)}`, lines: describe(f) }))];
      if (c.file_manifest_omitted && (!c.manifest_next_cursor || !array(file_manifest).length)) throw new ClientError('PROTOCOL_ERROR', 'Manifest 分页不完整');
      const more = next(c.manifest_next_cursor);
      return page('Candidate · ' + id, [...candidateHistoryLines(c), ...describe(detail), '', '验证报告请进入 Review；统计为本次读取观测。'], rows, more ? { ...more, tree: s(c.manifest_digest) } : undefined);
    }
    case 'compare': {
      const d = await q('compare', [...(route.pair ?? []), '--summary']);
      const candidates = array(d.candidates);
      if (candidates.length !== 2 || !(route.pair ?? []).every(x => candidates.some(c => c.candidate_id === x))) throw new ClientError('PROTOCOL_ERROR', '比较返回了其他 Candidate');
      const ordered = route.pair!.map(id => candidates.find(c => c.candidate_id === id)!);
      return page(`Compare · Issue ${s(record(d.issue).id)} v${s(record(d.issue).version)}`, ['账本比较，无需本机 Git；不计算增删行数。', '左右顺序按所选 ID 固定；Tab 查看各列详情。'], ordered.map((c, i) => ({ id: s(c.candidate_id), label: `${i === 0 ? '左' : '右'} · ${s(c.candidate_id)}`, lines: describe(c), route: { kind: 'candidate', id: s(c.candidate_id) } })));
    }
    case 'review': {
      const d = await q('review', [id, '--summary']); const t = record(d.trace);
      if (record(t.candidate).candidate_id !== id) throw new ClientError('PROTOCOL_ERROR', 'Review Candidate 不匹配');
      const submission = record(t.submission);
      return page('Review · ' + id, ['以下契约来自 Candidate 历史版本。', ...describe(t.contract), '', ...describe(t.candidate), ...describe(t.explanation_coverage), '作者提交说明与 Claims', ...describe(submission)], [
        { id: 'verification', label: `Verification · ${s(record(t.verification_set).count)} 份（正文按需打开）`, lines: describe(t.verification_set), route: { kind: 'verifications', id, set: record(t.verification_set), tree: s(record(t.artifact).result_tree_oid) } },
        ...array(record(t.change_index).change_units).map(unit => ({ id: s(unit.change_unit_id), label: `${s(unit.display_path)} · ${s(unit.kind)}`, lines: ['Change Unit（derived relation）', ...describe(unit), '', '作者理由（author claim）',
          ...describe(array(submission.change_rationales).filter(r => Array.isArray(r.change_refs) && r.change_refs.includes(unit.change_unit_id))),
          '引用关联不自动证明因果；未记录信息为 unknown。'] })),
      ]);
    }
    case 'verifications': {
      let active = route;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const d = await q('verifications', ['--candidate', id, '--paged', ...(active.cursor ? ['--cursor', active.cursor] : [])]);
          if (d.candidate_id !== id) throw new ClientError('PROTOCOL_ERROR', '验证目录 Candidate 不匹配');
          if (!sameSet(record(d.verification_set), active.set ?? {})) throw new ClientError('VERIFICATION_SET_CHANGED', '集合变化', true);
          const entries = array(d.verifications);
          if (entries.some(e => e.candidate_id !== id) || new Set(entries.map(e => e.verification_id)).size !== entries.length) throw new ClientError('PROTOCOL_ERROR', '验证目录重复或包含其他 Candidate');
          if (d.next_cursor && (!entries.length || d.next_cursor === active.cursor)) throw new ClientError('PROTOCOL_ERROR', '验证目录游标异常');
          return { ...page('Verification · 固定集合', [...describe(d.verification_set), `当前页 ${entries.length} 条；目录不代表正文已阅读。`], entries.map(e => ({ id: s(e.verification_id), label: `${s(e.overall_verdict)} · ${verificationMode(e)} · ${s(e.verification_id)}`, lines: describe(e), route: { kind: 'verification', id: s(e.verification_id), entry: e, tree: active.tree } })), d.next_cursor ? { ...active, cursor: String(d.next_cursor) } : undefined), note: attempt ? '集合变化，已重新读取首页' : undefined };
        } catch (e) {
          if (!(e instanceof ClientError) || e.code !== 'VERIFICATION_SET_CHANGED' || attempt === 2) throw e;
          const d = await q('review', [id, '--summary']); const t = record(d.trace);
          active = { kind: 'verifications', id, set: record(t.verification_set), tree: s(record(t.artifact).result_tree_oid) };
        }
      }
      throw new ClientError('VERIFICATION_SET_CHANGED', '请手动刷新');
    }
    case 'verification': {
      const d = await q('verification', [id]); const e = route.entry ?? {};
      if (d.verification_id !== id || d.candidate_id !== e.candidate_id || d.overall_verdict !== e.overall_verdict || verificationMode(d) !== verificationMode(e) || timestamp(d.created_at) !== timestamp(e.created_at)
        || canonical(d.attribution) !== canonical(e.attribution) || record(d.report).candidate_id !== e.candidate_id || record(d.report).result_tree_oid !== route.tree)
        throw new ClientError('PROTOCOL_ERROR', '验证正文与目录或 Candidate 工件不匹配');
      return page('Verification · 正文已打开', ['verifier finding：以下为原始记录，不是 TUI 新生成的判断。', `验收模式：${verificationMode(d)}`, ...describe(d)]);
    }
  }
}
