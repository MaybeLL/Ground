import type { Reader } from './client.js';
import { array, record, type Route } from './pages.js';
import { ClientError, type Data, type Method } from './protocol.js';

export const text = (v: unknown): string => v === undefined || v === null ? '未提供' : String(v);
const stamp = () => new Date().toLocaleTimeString();
export const warnings = (d: Data | undefined) => array(d?.warnings).map(w => `警告 ${text(w.code)}: ${text(w.message)}`);
const fail = (message: string): never => { throw new ClientError('PROTOCOL_ERROR', message); };
const check = (signal: AbortSignal) => signal.throwIfAborted();
export const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** One session, one database/config identity. Only data keys, never data, enter navigation frames. */
export class DataCache<T> {
  private entries = new Map<string, { value: T; size: number }>();
  private pins = new Set<string>();
  constructor(readonly limit = 16 * 1024 * 1024, readonly count = 10) {}
  pin(keys: string[]) { this.pins = new Set(keys); }
  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit) { this.entries.delete(key); this.entries.set(key, hit); }
    return hit?.value;
  }
  peek(key: string): T | undefined { return this.entries.get(key)?.value; }
  get size() { return [...this.entries.values()].reduce((n, x) => n + x.size, 0); }
  put(key: string, value: T) {
    const size = bytes(value);
    if (size > this.limit) throw new ClientError('VIEW_TOO_LARGE', '数据超过 16 MiB 视图预算；请用 CLI 缩小读取范围');
    const next = new Map(this.entries); next.delete(key); next.set(key, { value, size });
    const total = () => [...next.values()].reduce((n, x) => n + x.size, 0);
    for (const k of next.keys()) {
      if (total() <= this.limit && next.size <= this.count) break;
      if (k !== key && !this.pins.has(k)) next.delete(k);
    }
    if (total() > this.limit || next.size > this.count) throw new ClientError('VIEW_TOO_LARGE', '活动数据超过缓存预算；请返回后缩小读取范围');
    this.entries = next;
  }
}

export interface ResourceRow { id: string; label: string; route: Route; candidate?: boolean; pageAction?: 'next' | 'prev' }
export interface Screen {
  type: 'screen'; route: Route; title: string; rows: ResourceRow[]; time: string;
  overview?: Data; note?: string; next?: string; cursors?: string[]; singlePage?: boolean;
  warnings?: string[];
}
export interface Detail {
  type: 'detail'; route: Route; data: Data; time: string;
  note?: string;
  review?: Data; reviewTime?: string; directory?: Data; directoryTime?: string;
  manifestCursors?: string[]; directoryCursors?: string[]; singleManifest?: boolean; singleDirectory?: boolean;
}
type Entry = Screen | Detail;
export const screenKey = (r: Route) => `screen:${r.kind}:${r.id ?? ''}:${r.version ?? ''}:${r.pair?.join(',') ?? ''}`;
export const detailKey = (r: Route) => `detail:${r.kind}:${r.id ?? ''}:${r.version ?? ''}`;
const sameSet = (a: Data, b: Data) => a.digest === b.digest && a.count === b.count && a.standing === b.standing
  && ['qualified', 'rejected', 'inconclusive'].every(k => record(a.verdict_counts)[k] === record(b.verdict_counts)[k]);
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(record(v)[k])}`).join(',')}}` : JSON.stringify(v);
const timestamp = (v: unknown) => text(v).replace(/\.(\d+)Z$/, (_, digits: string) => { const s = digits.replace(/0+$/, ''); return s ? `.${s}Z` : 'Z'; });
export function validateReport(data: Data, route: Route) {
  const e = route.entry ?? {};
  if (data.verification_id !== route.id || data.candidate_id !== e.candidate_id || data.overall_verdict !== e.overall_verdict
    || timestamp(data.created_at) !== timestamp(e.created_at) || canonical(data.attribution) !== canonical(e.attribution)
    || record(data.report).candidate_id !== e.candidate_id || record(data.report).result_tree_oid !== route.tree) fail('验证正文与目录或 Candidate 工件不匹配');
}
function cursor(data: Data, field: string, omitted: string | undefined, previous: string[], entries: Data[]) {
  const next = data[field];
  if (omitted && data[omitted] && !next) fail('分页不完整：缺少下一游标');
  if (next && (typeof next !== 'string' || !entries.length || previous.includes(next))) fail('分页游标重复或没有前进');
}
function append(old: Data[], incoming: Data[], id: (d: Data) => unknown): Data[] {
  const map = new Map(old.map(d => [id(d), d]));
  for (const d of incoming) {
    const key = id(d);
    if (key === undefined || map.has(key)) fail('分页存在重复资源或身份冲突');
    map.set(key, d);
  }
  return [...map.values()];
}
const resourceRows = (data: Data, kind: Route['kind']): ResourceRow[] => array(data.resources).map(r => ({
  id: text(r.resource_id), label: `${text(r.label)}${r.version ? ` · v${r.version}` : ''}${r.state ? ` · ${r.state}` : ''} · ${text(r.resource_id)}`,
  route: { kind, id: text(r.resource_id) }, candidate: kind === 'candidate',
}));

export class Workspace {
  readonly cache: DataCache<Entry>;
  constructor(private reader: Reader, limit?: number) { this.cache = new DataCache(limit); }
  screen(r: Route) { const e = this.cache.peek(screenKey(r)); return e?.type === 'screen' ? e : undefined; }
  detail(r: Route) { const e = this.cache.peek(detailKey(r)); return e?.type === 'detail' ? e : undefined; }
  private async query(method: Method, args: string[], signal: AbortSignal) { const d = await this.reader.query(method, args, signal); check(signal); return d; }
  async loadScreen(route: Route, signal: AbortSignal, refresh = false): Promise<Screen> {
    const cached = this.screen(route);
    if (cached && !refresh) { this.cache.get(screenKey(route)); return cached; }
    const id = route.id ?? '';
    const notices: string[] = [];
    const q = async (method: Method, args: string[]) => { const d = await this.query(method, args, signal); notices.push(...warnings(d)); return d; };
    let result: Screen;
    if (route.kind === 'home') {
      const d = await q('requirements', []);
      result = { type: 'screen', route, title: 'Requirement · 全部账本', rows: resourceRows(d, 'requirement'), time: stamp() };
    } else if (route.kind === 'requirement') {
      let d: Data, degraded: ClientError | undefined;
      try {
        d = await q('requirement', [id]);
        if (record(d.requirement).id !== id) fail('Requirement 身份不匹配');
        cursor(d, 'issues_next_cursor', 'issues_omitted', [], array(d.issues));
      } catch (error) {
        // Requirement reads aggregate Candidate standings, so one unreadable stored
        // Candidate must not hide the Requirement's readable Issue list.
        if (!(error instanceof ClientError) || error.code !== 'ARTIFACT_INTEGRITY_ERROR') throw error;
        degraded = error;
        d = await q('issues', ['--requirement', id]);
      }
      result = this.requirementScreen(route, d, degraded);
    } else if (route.kind === 'issue' || route.kind === 'candidates') {
      const current = await q('issue', [id]); const issue = record(current.issue);
      if (issue.id !== id || !Number.isInteger(issue.version)) fail('Issue 身份或版本不匹配');
      const version = route.version ?? Number(issue.version);
      const pinned: Route = { kind: 'issue', id, version };
      const old = this.screen(pinned);
      let rows: ResourceRow[] = [], unreadable: ClientError | undefined;
      try {
        const d = await q('candidates', ['--issue', id, '--issue-version', String(version)]);
        rows = resourceRows(d, 'candidate').map(r => ({ ...r, route: { ...r.route, issueId: id, version } }));
      } catch (error) {
        // An unreadable stored Candidate must not hide the Issue board or its DevRuns.
        if (!(error instanceof ClientError) || error.code !== 'ARTIFACT_INTEGRITY_ERROR') throw error;
        unreadable = error;
      }
      const notes = [
        issue.version !== version ? `当前已为 v${issue.version}，本页仍为 v${version}` : '',
        unreadable ? `Candidate 列表不可读（${unreadable.code}：${unreadable.message}）；Issue 概览与 DevRun 仍可浏览` : '',
        !unreadable && !rows.length ? `此 Issue v${version} 暂无 Candidate` : '',
      ].filter(Boolean);
      result = { type: 'screen', route: pinned, title: `Candidates · Issue ${id} v${version}`, time: stamp(),
        overview: issue.version === version ? current : old?.overview,
        note: notes.length ? notes.join(' · ') : undefined,
        rows: [{ id: '__issue', label: `Issue 概览 · v${version}`, route: { kind: 'issue', id, version } },
          { id: '__devruns', label: 'DevRuns（全部版本）', route: { kind: 'devruns', id } }, ...rows] };
      if (issue.version !== version) result.rows.push({ id: '__current', label: `查看当前版本 v${issue.version}`, route: { kind: 'issue', id } });
      // Store only a version identity for switching; never substitute the current contract into a pinned page.
    } else if (route.kind === 'devruns') {
      const d = await q('devruns', ['--issue', id]);
      result = { type: 'screen', route, title: 'DevRuns · 全部 Issue 版本', rows: resourceRows(d, 'devrun'), time: stamp() };
    } else if (route.kind === 'compare') {
      const d = await q('compare', [...(route.pair ?? []), '--summary']);
      const candidates = array(d.candidates);
      if (candidates.length !== 2 || !(route.pair ?? []).every(x => candidates.some(c => c.candidate_id === x))) fail('比较返回了其他 Candidate');
      result = { type: 'screen', route, title: `Compare · Issue ${text(record(d.issue).id)} v${text(record(d.issue).version)}`, time: stamp(), overview: { ...d, candidates: route.pair!.map(id => candidates.find(c => c.candidate_id === id)) }, rows: [] };
    } else {
      result = { type: 'screen', route, title: `${route.kind} · ${id}`, time: stamp(), rows: [{ id, label: `${route.kind} · ${id}`, route }] };
    }
    result.warnings = notices;
    check(signal); this.cache.put(screenKey(result.route), result); return result;
  }
  private requirementScreen(route: Route, d: Data, degraded?: ClientError): Screen {
    if (degraded) {
      const rows = resourceRows(d, 'issue');
      return { type: 'screen', route, title: `Requirement · ${text(route.id)}`, overview: undefined, time: stamp(), warnings: warnings(d), cursors: [],
        note: `Requirement 详情读取失败（${degraded.code}：${degraded.message}）；已降级为 Issue 列表，Issue 与 Candidate 仍可打开`,
        rows: [{ id: '__requirement', label: '需求概览（读取失败）', route }, ...rows] };
    }
    const r = record(d.requirement);
    const issues = array(d.issues);
    return { type: 'screen', route, title: `Requirement · ${text(r.summary)} · v${text(r.version)}`, overview: d, time: stamp(), warnings: warnings(d),
      note: issues.length ? undefined : '此 Requirement 暂无 Issue；Candidate 需经 Issue 版本浏览',
      next: d.issues_next_cursor as string | undefined, cursors: [], rows: [
        { id: '__requirement', label: '需求概览', route },
        ...issues.map(entry => { const i = record(entry.issue); return { id: text(i.id), label: `${text(i.summary)} · v${text(i.version)} · 需求 v${text(record(i.requirement).version)}${entry.bound_to_selected_version === false ? '（其他版本）' : ''}`, route: { kind: 'issue' as const, id: text(i.id) } }; }),
      ] };
  }
  async moreIssues(route: Route, signal: AbortSignal, previous = false): Promise<Screen> {
    const old = this.screen(route); if (!old) throw new ClientError('CACHE_MISS', '页面已淘汰，请刷新');
    const history = old.cursors ?? [];
    const next = previous ? history.at(-2) : old.next;
    if (!previous && !next) return old;
    let d: Data;
    try { d = await this.query('requirement', [route.id!, ...(next ? ['--issues-cursor', next] : [])], signal); }
    catch (e) { if (!(e instanceof ClientError) || e.code !== 'VALIDATION_ERROR') throw e; d = await this.query('requirement', [route.id!], signal); if (record(d.requirement).version === record(old.overview?.requirement).version) throw e; }
    if (record(d.requirement).id !== route.id) fail('Requirement 身份不匹配');
    if (record(d.requirement).version !== record(old.overview?.requirement).version) {
      const first = await this.loadScreen(route, signal, true); first.note = 'Requirement 版本变化，已清除旧分页并重新读取首页'; this.cache.put(screenKey(route), first); return first;
    }
    cursor(d, 'issues_next_cursor', 'issues_omitted', previous ? [] : [...history, next ?? ''], array(d.issues));
    const single = this.requirementScreen(route, d); single.cursors = previous ? history.slice(0, -1) : [...history, next ?? ''];
    if (!old.singlePage && !previous) {
      const joined = append(array(old.overview?.issues), array(d.issues), e => record(e.issue).id);
      const combined = this.requirementScreen(route, { ...d, issues: joined }); combined.cursors = single.cursors;
      try { this.cache.put(screenKey(route), combined); return combined; } catch (e) { if (!(e instanceof ClientError) || e.code !== 'VIEW_TOO_LARGE') throw e; }
    }
    single.singlePage = true; single.note = '缓存预算：单页浏览，使用上一页/下一页'; this.cache.put(screenKey(route), single); return single;
  }
  async loadDetail(route: Route, signal: AbortSignal, refresh = false): Promise<Detail> {
    check(signal);
    const screen = this.screen(route);
    if (screen && (route.kind === 'requirement' || route.kind === 'issue' && route.version)) {
      const overview = screen.overview;
      const data = route.kind === 'requirement' && overview ? { requirement: overview.requirement, issues: overview.issues, issues_omitted: overview.issues_omitted, aggregates: overview.aggregates, warnings: overview.warnings }
        : overview ?? { issue: { id: route.id, version: route.version }, unavailable: '旧契约快照已淘汰；可查看当前版本，不能用当前契约冒充历史' };
      const result: Detail = { type: 'detail', route, data, time: screen.time };
      check(signal); this.cache.put(detailKey(route), result); return result;
    }
    const cached = this.detail(route); if (cached && !refresh) {
      this.cache.get(detailKey(route));
      if (route.kind === 'candidate' && route.issueId && (record(record(cached.data.candidate).issue).id !== route.issueId || record(record(cached.data.candidate).issue).version !== route.version)) fail('Candidate 不属于当前固定 Issue 版本');
      if (route.kind === 'verification') validateReport(cached.data, route);
      if (route.kind === 'candidate' && cached.directory) return this.expand(route, 'reports', signal, true);
      return cached;
    }
    const id = route.id ?? ''; let d: Data;
    if (route.kind === 'issue' && route.version) {
      d = this.screen(route)?.overview ?? { issue: { id, version: route.version }, unavailable: '旧契约快照已淘汰；可查看当前版本，不能用当前契约冒充历史' };
    } else if (route.kind === 'requirement') {
      d = !refresh && this.screen(route)?.overview || await this.query('requirement', [id], signal);
      if (record(d.requirement).id !== id) fail('Requirement 身份不匹配');
      d = { requirement: d.requirement, issues: d.issues, issues_omitted: d.issues_omitted, aggregates: d.aggregates, warnings: d.warnings };
    } else if (route.kind === 'candidate') {
      d = await this.query('candidate', [id], signal); const c = record(d.candidate);
      if (c.candidate_id !== id) fail('Candidate 身份不匹配');
      if (c.git_artifact) {
        c.archive_status = await loadCandidateArchiveStatus(this.reader, id, c.git_artifact, signal);
      }
      if (route.issueId && (record(c.issue).id !== route.issueId || record(c.issue).version !== route.version)) fail('Candidate 不属于当前固定 Issue 版本');
      cursor(c, 'manifest_next_cursor', 'file_manifest_omitted', [], array(c.file_manifest));
    } else if (route.kind === 'verification') {
      d = await this.query('verification', [id], signal); validateReport(d, route);
    } else if (route.kind === 'issue') {
      d = await this.query('issue', [id], signal); if (record(d.issue).id !== id) fail('Issue 身份不匹配');
    } else if (route.kind === 'devrun') {
      d = await this.query('devrun', [id], signal); if (d.dev_run_id !== id) fail('DevRun 身份不匹配');
    } else d = { summary: 'Enter 打开资源列表' };
    const result: Detail = { type: 'detail', route, data: d, time: stamp() };
    check(signal); this.cache.put(detailKey(route), result); return result;
  }
  private async review(detail: Detail, signal: AbortSignal): Promise<Detail> {
    const d = await this.query('review', [detail.route.id!, '--summary'], signal); const t = record(d.trace), c = record(detail.data.candidate);
    if (record(t.candidate).candidate_id !== detail.route.id || record(t.artifact).result_tree_oid !== c.result_tree_oid
      || record(record(t.contract).issue).id !== record(c.issue).id || record(record(t.contract).issue).version !== record(c.issue).version) fail('Review 与 Candidate 工件或契约不匹配');
    return { ...detail, review: { ...t, warnings: d.warnings }, reviewTime: stamp(), directory: undefined, directoryCursors: [] };
  }
  async expand(route: Route, task: 'review' | 'reports' | 'manifest-next' | 'manifest-prev' | 'reports-next' | 'reports-prev', signal: AbortSignal, recheck = false): Promise<Detail> {
    let d = this.detail(route); if (!d) throw new ClientError('CACHE_MISS', '详情已淘汰，请刷新');
    if (task.startsWith('manifest-')) {
      const c = record(d.data.candidate), history = d.manifestCursors ?? [], prev = task.endsWith('prev');
      const next = prev ? history.at(-2) : c.manifest_next_cursor;
      if (!prev && !next) return d;
      const raw = await this.query('candidate', [route.id!, ...(next ? ['--manifest-cursor', String(next)] : [])], signal); const candidate = record(raw.candidate);
      if (candidate.candidate_id !== route.id || candidate.manifest_digest !== c.manifest_digest || candidate.result_tree_oid !== c.result_tree_oid) fail('Candidate manifest 身份变化');
      cursor(candidate, 'manifest_next_cursor', 'file_manifest_omitted', prev ? [] : [...history, String(next)], array(candidate.file_manifest));
      // Manifest paging must not overwrite the independently observed Selection/verification summary.
      const single: Detail = { ...d, data: { ...d.data, candidate: { ...c, file_manifest: candidate.file_manifest, file_manifest_omitted: candidate.file_manifest_omitted, manifest_next_cursor: candidate.manifest_next_cursor } }, manifestCursors: prev ? history.slice(0, -1) : [...history, String(next)] };
      if (!d.singleManifest && !prev) {
        const combined = { ...single, data: { ...single.data, candidate: { ...record(single.data.candidate), file_manifest: append(array(c.file_manifest), array(candidate.file_manifest), f => f.path_bytes) } } };
        try { this.cache.put(detailKey(route), combined); return combined; } catch (e) { if (!(e instanceof ClientError) || e.code !== 'VIEW_TOO_LARGE') throw e; }
      }
      d = { ...single, singleManifest: true };
    } else {
      if (!d.review) d = await this.review(d, signal);
      const rechecking = recheck ? d : undefined;
      if (recheck) d = { ...d, directory: undefined, directoryCursors: [] };
      if (task !== 'review') {
        const previous = task === 'reports-prev'; const old = d.directory; const history = d.directoryCursors ?? [];
        let next = previous ? history.at(-2) : task === 'reports-next' ? old?.next_cursor : undefined;
        if (task === 'reports' && old) return d;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const page = await this.query('verifications', ['--candidate', route.id!, '--paged', ...(next ? ['--cursor', String(next)] : [])], signal);
            if (page.candidate_id !== route.id) fail('验证目录 Candidate 不匹配');
            if (!sameSet(record(page.verification_set), record(d.review?.verification_set))) throw new ClientError('VERIFICATION_SET_CHANGED', '验证集合变化');
            const entries = array(page.verifications);
            if (entries.some(e => e.candidate_id !== route.id) || new Set(entries.map(e => e.verification_id)).size !== entries.length) fail('验证目录重复或包含其他 Candidate');
            cursor(page, 'next_cursor', undefined, previous || attempt ? [] : [...history, String(next ?? '')], entries);
            let merged = page;
            const single = previous || d.singleDirectory;
            if (task === 'reports-next' && old && !single && attempt === 0) merged = { ...page, verifications: append(array(old.verifications), entries, e => e.verification_id) };
            if ((!next || merged !== page) && !page.next_cursor && array(merged.verifications).length !== record(page.verification_set).count) fail('验证目录不完整：数量与集合不符，缺少下一游标');
            // An unchanged set preserves all loaded pages and the user's exact report node on return.
            if (rechecking?.directory && attempt === 0) {
              const unchanged = { ...rechecking, directoryTime: stamp() };
              this.cache.put(detailKey(route), unchanged); return unchanged;
            }
            const result: Detail = { ...d, directory: merged, directoryTime: stamp(), directoryCursors: attempt ? [] : previous ? history.slice(0, -1) : next ? [...history, String(next)] : [], singleDirectory: single,
              note: attempt ? '验证集合变化，已重新读取首页' : d.note };
            try { this.cache.put(detailKey(route), result); return result; } catch (e) { if (!(e instanceof ClientError) || e.code !== 'VIEW_TOO_LARGE' || merged === page) throw e; }
            d = { ...result, directory: page, singleDirectory: true }; break;
          } catch (e) {
            if (!(e instanceof ClientError) || e.code !== 'VERIFICATION_SET_CHANGED') throw e;
            if (attempt === 2) throw new ClientError('VERIFICATION_SET_CHANGED', '验证集合持续变化，请手动刷新', true);
            d = await this.review(d, signal); next = undefined;
          }
        }
      }
    }
    check(signal); this.cache.put(detailKey(route), d); return d;
  }
}
import { loadCandidateArchiveStatus } from './candidate-history.js';
