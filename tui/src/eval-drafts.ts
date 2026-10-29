import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { operationId } from './review-model.js';
import { ClientError, type Data } from './protocol.js';
import type { EvalAccess, EvalRecord, FrozenPublication, HumanIdentity, Publication, Ref } from './eval-protocol.js';

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error('内容含无效 Unicode'); return JSON.stringify(value); }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => canonical(k) + ':' + canonical((value as Data)[k])).join(',') + '}';
  throw new Error('内容无法规范化');
}
export const digest = (v: unknown) => 'sha256:' + createHash('sha256').update(canonical(v)).digest('hex');
export interface Draft { format: 'grounds.tui-eval-draft/v1'; id: string; databaseId: string; state: 'editing' | 'prepared' | 'pending' | 'rejected' | 'published'; publication: Publication; original?: EvalRecord; returnTo?: string; returnToTask?: { index: number; id?: string }; editingVersion: string; request?: FrozenPublication; requestDigest?: string; result?: EvalRecord; error?: string }
const publication = z.object({ command: z.enum(['qa.publish', 'grader.publish', 'suite.create', 'suite.task.add', 'suite.task.update', 'suite.task.remove', 'suite.tasks.publish']), id: z.string().min(1).optional(), expectedVersion: z.number().int().positive().optional(), taskId: z.string().min(1).optional(), body: z.record(z.string(), z.unknown()).optional(), name: z.string().optional() });
const human = z.object({ kind: z.literal('human'), git_name: z.string().min(1), git_email: z.string().min(1) });
const frozen = publication.extend({ operationId: z.uuid(), databaseId: z.string().min(1), attribution: human });
const schema = z.object({ format: z.literal('grounds.tui-eval-draft/v1'), id: z.uuid(), databaseId: z.string().min(1), state: z.enum(['editing', 'prepared', 'pending', 'rejected', 'published']), publication, original: z.custom<EvalRecord>().optional(), returnTo: z.uuid().optional(), returnToTask: z.object({ index: z.number().int().nonnegative(), id: z.string().min(1).optional() }).optional(), editingVersion: z.uuid(), request: frozen.optional(), requestDigest: z.string().optional(), result: z.custom<EvalRecord>().optional(), error: z.string().optional() });
export class DraftStore {
  constructor(readonly root = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'grounds-tui', 'eval')) {}
  async initialize() { await mkdir(this.root, { recursive: true, mode: 0o700 }); const stat = await lstat(this.root); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('草稿目录必须是真实私有目录'); await chmod(this.root, 0o700); }
  path(id: string) { if (!z.uuid().safeParse(id).success) throw new Error('草稿身份无效'); return join(this.root, id + '.json'); }
  async save(draft: Draft) {
    schema.parse(draft); await this.initialize();
    const temp = join(this.root, '.' + randomUUID()); const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(draft)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.path(draft.id));
    const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async load(id: string): Promise<Draft> {
    const handle = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('草稿格式或大小异常'); const d = schema.parse(JSON.parse(await handle.readFile('utf8'))) as Draft; if (d.id !== id) throw new Error('草稿身份不匹配'); if (d.request && digest(d.request) !== d.requestDigest) throw new Error('待恢复请求摘要不匹配'); return d; } finally { await handle.close(); }
  }
  async list(): Promise<Draft[]> { await this.initialize(); const names = (await readdir(this.root)).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)); return Promise.all(names.sort().map(n => this.load(n.slice(0, -5)))); }
  async create(databaseId: string, value: Publication, original?: EvalRecord, returnTo?: string, returnToTask?: Draft['returnToTask']): Promise<Draft> { const d: Draft = { format: 'grounds.tui-eval-draft/v1', id: randomUUID(), databaseId, state: 'editing', publication: structuredClone(value), editingVersion: randomUUID(), ...(original ? { original: structuredClone(original) } : {}), ...(returnTo ? { returnTo } : {}), ...(returnToTask ? { returnToTask } : {}) }; await this.save(d); return d; }
  async edit(d: Draft, value: Publication): Promise<Draft> {
    const current = await this.load(d.id); if (current.state === 'pending' || current.state === 'published') throw new Error('先核查待确认写入；已发布草稿不能再次编辑');
    const next: Draft = { ...current, state: 'editing', publication: structuredClone(value), editingVersion: randomUUID() }; delete next.request; delete next.requestDigest; delete next.error; await this.save(next); return next;
  }
  async discard(d: Draft) { const current = await this.load(d.id); if (current.state === 'pending') throw new Error('结果未知，不能丢弃待恢复请求'); await rm(this.path(d.id)); }
  async prepare(d: Draft, identity: HumanIdentity): Promise<Draft> {
    const current = await this.load(d.id); if (current.state === 'pending' || current.state === 'published') throw new Error('该草稿已发送，请先查看结果');
    const p = compilePublication(current); validatePublication(p);
    const request = { ...p, operationId: operationId(), databaseId: current.databaseId, attribution: human.parse(identity) };
    const next: Draft = { ...current, state: 'prepared', request, requestDigest: digest(request) }; await this.save(next); return next;
  }
  async send(d: Draft, access: EvalAccess, allowOriginalIdentity = false): Promise<Draft> {
    const current = await this.load(d.id);
    if (!['prepared', 'pending'].includes(current.state) || !current.request) throw new Error('请先预览并确认发布');
    if (await access.database() !== current.databaseId) throw new ClientError('DATABASE_ID_MISMATCH', '此草稿属于另一账本，请恢复原数据库配置');
    const identity = await access.identity();
    if (canonical(identity) !== canonical(current.request.attribution) && !allowOriginalIdentity) throw new ClientError('IDENTITY_CHANGED', '当前归属与原请求不同；需明确选择按原归属恢复');
    const pending: Draft = { ...current, state: 'pending' }; await this.save(pending);
    try { const result = await access.publish(current.request); const done: Draft = { ...pending, state: 'published', result }; delete done.error; await this.save(done); return done; }
    catch (error) {
      // Only definitive domain rejections permit editing; transport/internal errors remain uncertain.
      const rejected = error instanceof ClientError && ['VALIDATION_ERROR', 'VERSION_CONFLICT', 'NOT_FOUND'].includes(error.code);
      await this.save({ ...pending, state: rejected ? 'rejected' : 'pending', error: error instanceof Error ? error.message : String(error) }); throw error;
    }
  }
}
export function qaBody(draft: Draft): Data {
  const raw = structuredClone(draft.publication.body ?? {}); delete raw.source;
  const previousSource = draft.original?.data.source as Data | undefined;
  const previousRecord = previousSource?.record as Data | undefined;
  if (draft.publication.id && previousRecord?.source_package) {
    // Captured provenance is immutable; human authoring adds a revision record,
    // instead of replacing collection locators with a fabricated manual path.
    return { ...raw, source: { ...structuredClone(previousSource), record: { ...structuredClone(previousRecord), manual_revision: { kind: 'human', draft_id: draft.id, editing_version: draft.editingVersion, digest: digest(raw), based_on: { id: draft.original!.id, version: draft.original!.version } } } } };
  }
  return { ...raw, source: { identity: draft.publication.id ? previousSource?.identity : `manual:${draft.id}`, repository: 'manual', revision: `manual:${draft.editingVersion}`, path: `manual/${draft.id}`, digest: digest(raw), record: { kind: draft.original ? 'manual_revision' : 'manual', format: 'grounds.tui-qa-source/v1', digest_algorithm: 'JCS-SHA256', ...(draft.original ? { based_on: { id: draft.original.id, version: draft.original.version } } : {}) } } };
}
export function compilePublication(draft: Draft): Publication { return { ...structuredClone(draft.publication), ...(draft.publication.command === 'qa.publish' ? { body: qaBody(draft) } : {}) }; }
function text(v: unknown, name: string, max = 65536) { if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max) throw new Error(`${name}：需要非空文本，最多 ${max} 字节`); }
function obj(v: unknown): Data { return v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {}; }
function reference(v: unknown) { const r = obj(v); text(r.id, '任务身份'); if (!Number.isSafeInteger(r.version) || Number(r.version) < 1) throw new Error('请选择精确任务版本'); }
export function validatePublication(p: Publication) {
  publication.parse(p);
  if (p.id && p.expectedVersion === undefined) throw new Error('修订需要原版本');
  if (p.command === 'suite.create') { text(p.name, '题集名称', 1024); return; }
  if (p.command === 'suite.tasks.publish') {
    if (!p.id || !p.expectedVersion || p.body?.format !== 'grounds.eval-suite-members/v1' || !Array.isArray(p.body.tasks) || p.body.tasks.length > 1000) throw new Error('题集统一发布需要固定题集、版本及最多 1000 项成员');
    const ids = new Set<string>();
    for (const value of p.body.tasks) {
      const task = obj(value);
      if (task.id !== undefined) { text(task.id, '成员身份'); if (ids.has(String(task.id))) throw new Error('成员身份重复'); ids.add(String(task.id)); }
      text(task.name, '成员名称', 1024); reference(task.qa ?? task.issue);
      const refs = task.graders as Ref[];
      if (!Array.isArray(refs) || !refs.length || refs.length > 100 || new Set(refs.map(r => r.id)).size !== refs.length) throw new Error('每项成员须绑定 1–100 个不重复的评分规则');
      refs.forEach(reference);
    }
    return;
  }
  if (p.command === 'suite.task.remove') { text(p.taskId, '任务'); return; }
  const b = p.body ?? {};
  if (p.command.startsWith('suite.task.')) { text(b.name, '任务名称'); reference(b.qa ?? b.issue); const refs = b.graders as Ref[]; if (!Array.isArray(refs) || !refs.length || refs.length > 100 || new Set(refs.map(r => r.id)).size !== refs.length) throw new Error('请选择 1–100 个不重复的评分规则'); refs.forEach(reference); return; }
  text(b.name, '名称', 1024);
  if (p.command === 'qa.publish') {
    for (const k of ['question', 'instructions', 'rubric']) text(b[k], k);
    if (b.reference_answer !== undefined) text(b.reference_answer, '参考答案');
    for (const k of ['required_points', 'forbidden_claims', 'references']) { if (!Array.isArray(b[k]) || (b[k] as unknown[]).length > 1000) throw new Error(`${k}：最多 1000 项`); (b[k] as unknown[]).forEach(v => text(v, k)); }
    return;
  }
  reference(b.qa ?? b.issue); text(b.limitations, '评分局限');
  const scope = obj(b.scope), spec = obj(b.result_spec), definition = obj(b.definition);
  if (scope.kind === 'diagnostic') text(scope.name, '评分维度');
  else if (scope.kind !== 'criterion' || !Array.isArray(scope.criterion_ids) || !scope.criterion_ids.length || new Set(scope.criterion_ids).size !== scope.criterion_ids.length) throw new Error('请选择不重复的 Criterion');
  if (b.qa && (scope.kind !== 'diagnostic' || spec.kind !== 'qa_decision' || definition.type !== 'agent')) throw new Error('QA 只支持 Agent + diagnostic + qa_decision');
  if (definition.type === 'agent') text(definition.instructions, 'Agent 指令');
  else if (definition.type === 'unit_test') {
    if (b.qa || definition.adapter !== 'go' || spec.kind !== 'decision') throw new Error('Go 评分仅支持 Coding decision');
    if (!/^(\.|[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.test(String(definition.package))) throw new Error('Go package 需要相对路径');
    if (!/^Test[A-Z0-9_][A-Za-z0-9_]*$/.test(String(definition.test_name))) throw new Error('请输入精确 Go Test 函数名');
    if (!Number.isSafeInteger(definition.timeout_seconds) || Number(definition.timeout_seconds) < 1 || Number(definition.timeout_seconds) > 300) throw new Error('超时须为 1–300 秒');
    const files = definition.files as Data[];
    if (!Array.isArray(files) || files.length < 1 || files.length > 20 || new Set(files.map(f => f.path)).size !== files.length) throw new Error('Go 需要 1–20 个不重名测试文件');
    for (const f of files) { if (!/^[A-Za-z0-9_-]+_test\.go$/.test(String(f.path))) throw new Error('测试文件须为包内纯文件名 *_test.go'); text(f.content, '测试正文'); }
  } else throw new Error('请选择 Agent 或 Go 评分');
  if (spec.kind === 'score') { if (!Number.isFinite(spec.min) || !Number.isFinite(spec.max) || Number(spec.min) >= Number(spec.max) || typeof spec.higher_is_better !== 'boolean') throw new Error('评分区间无效'); text(spec.rubric, '分数 rubric'); }
  else if (spec.kind !== (b.qa ? 'qa_decision' : 'decision')) throw new Error('结果类型无效');
}
export const newQA = (): Data => ({ format: 'grounds.eval-qa/v1', name: '', question: '', instructions: '', rubric: '', required_points: [], forbidden_claims: [], references: [] });
export const newGrader = (task: { qa?: Ref; issue?: Ref }): Data => ({ format: task.qa ? 'grounds.eval-grader/v1' : 'patchledger.eval-grader/v1', ...task, name: '', scope: { kind: 'diagnostic', name: '' }, result_spec: { kind: task.qa ? 'qa_decision' : 'decision' }, definition: { type: 'agent', instructions: '' }, limitations: '' });

// Parse the user's executable and arguments without shell expansion or interpolation.
export function editorCommand(value: string): string[] {
  const args: string[] = []; let word = '', quote = '', started = false, escape = false;
  for (const ch of value) {
    if (escape) { word += ch; escape = false; started = true; }
    else if (ch === '\\' && quote !== "'") escape = true;
    else if (quote) { if (ch === quote) quote = ''; else word += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { args.push(word); word = ''; started = false; } }
    else { word += ch; started = true; }
  }
  if (quote || escape) throw new Error('VISUAL/EDITOR 引号不完整');
  if (started) args.push(word); if (!args[0]) throw new Error('请配置 VISUAL 或 EDITOR（图形编辑器需要等待参数，如 --wait）'); return args;
}
const DEFAULT_EDITOR = 'vim';
export async function editText(root: string, textValue: string, suspend: () => Promise<() => void | Promise<void>> = async () => () => {}, command = process.env.VISUAL || process.env.EDITOR || DEFAULT_EDITOR): Promise<string> {
  const usingDefault = command === DEFAULT_EDITOR && !process.env.VISUAL && !process.env.EDITOR;
  const [program, ...args] = editorCommand(command); await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'edit-' + randomUUID() + '.txt'); const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(textValue); } finally { await handle.close(); }
  const resume = await suspend();
  try {
    await new Promise<void>((resolve, reject) => { const p = spawn(program, [...args, path], { shell: false, stdio: 'inherit' }); p.once('error', reject); p.once('close', code => code === 0 ? resolve() : reject(new Error(`编辑器退出码 ${code}；内容保留于 ${path}`))); });
    const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error(`编辑文件无效或超过 64 KiB；保留于 ${path}`);
    let result: string; try { result = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)); } catch { throw new Error(`编辑内容不是有效 UTF-8；保留于 ${path}`); } await rm(path); return result;
  } catch (error) { const missing = usingDefault && (error as NodeJS.ErrnoException)?.code === 'ENOENT'; throw new Error(missing ? `未找到 vim；请安装 vim，或设置 EDITOR（图形编辑器需要等待参数，如 --wait）；内容保留于 ${path}` : `编辑未完成，请检查 VISUAL/EDITOR；内容保留于 ${path}：${error instanceof Error ? error.message : String(error)}`); } finally { await resume(); }
}
