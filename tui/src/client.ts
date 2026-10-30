import { parseEvalEnvelope, fixedRecord, type EvalAccess, type EvalRead, type FrozenPublication, type HumanIdentity, type EvalRecord } from './eval-protocol.js';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { ClientTemporaryFiles } from './client-temp.js';
import { ClientError, decode, methods, type Data, type Method } from './protocol.js';
import { operationId } from './review-model.js';

export interface Options { cli?: string; cwd: string; config?: string; timeout: number; signal?: AbortSignal; review?: boolean; temporaryRoot?: string }
export interface Context { cli: string; version: string; configSource: string; databaseId: string; driver: string; cwd: string }
export interface Reader { query(method: Method, args?: string[], signal?: AbortSignal): Promise<Data> }
export interface SelectionRequest { issue: string; version: number; candidate: string; expectedVersion: number; operationId: string; reason: string }
export interface SelectionWriter { selectCandidate(request: SelectionRequest): Promise<Data>; selectionIdentity?(): Promise<string> }

export async function executable(request = 'grounds'): Promise<string> {
  for (const file of request.includes('/') ? [resolve(request)] : (process.env.PATH ?? '').split(delimiter).map(p => resolve(p, request))) {
    try { await access(file, constants.X_OK); return await realpath(file); } catch { /* next PATH entry */ }
  }
  throw new ClientError('CLI_NOT_FOUND', `找不到 ${request}；请安装核心 CLI 或传入 --cli PATH`);
}

export function invoke(cli: string, args: string[], cwd: string, timeout: number, signal?: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<{ stdout: string; exit: number | null }> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(new ClientError('CANCELLED', '已取消')); return; }
    const child = spawn(cli, args, { cwd, env: environment ?? process.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = Buffer.alloc(0), failed: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (s: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, s); } catch { /* already exited */ } } };
    const fail = (error: Error) => {
      if (failed) return;
      failed = error; kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const abort = () => fail(new ClientError('CANCELLED', '已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fail(new ClientError('TIMEOUT', '查询超时，可调整 --query-timeout 后重试')), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) fail(new ClientError('OUTPUT_LIMIT', 'CLI 输出超过 16 MiB'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536); });
    child.once('error', error => { failed = error; });
    child.once('close', exit => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Finish terminating the group even if its launcher closes stdout first.
      if (failed) { kill('SIGKILL'); if (killTimer) clearTimeout(killTimer); reject(failed); }
      else if (bytes === 0) reject(new ClientError('PROCESS_ERROR', `CLI 未返回结果：${stderr.toString('utf8')}`));
      else resolveResult({ stdout: Buffer.concat(chunks).toString('utf8'), exit });
    });
  });
}

export class Client implements Reader, EvalAccess {
  context!: Context;
  private directory?: string;
  private config?: string;
  private running = 0;
  private waiters: (() => void)[] = [];
  private pending = new Set<AbortController>();
  private closed = false;
  private evalChecked?: Promise<void>;
  private temporary: ClientTemporaryFiles;
  constructor(private options: Options, private cli: string) { this.temporary = new ClientTemporaryFiles(options.temporaryRoot); }
  static async open(options: Options): Promise<Client> {
    const c = new Client(options, await executable(options.cli));
    try { await c.initialize(); return c; } catch (error) { await c.close(); throw error; }
  }
  private async initialize(): Promise<void> {
    const version = await this.raw('version', []);
    // The TUI and core CLI ship together because their command surface is private integration API.
    const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    if (String(version.version) !== expectedVersion) throw new ClientError('CLI_INCOMPATIBLE', `尚未验证 CLI ${version.version}，请安装 Grounds CLI ${expectedVersion}（https://github.com/MaybeLL/Ground/releases）`);
    for (const [argv, option] of [[['candidate', 'compare', '--help'], '--summary'], [['candidate', 'list', '--help'], '--issue-version']] as const) {
      const r = await invoke(this.cli, [...argv, '--json'], this.options.cwd, this.options.timeout, this.options.signal);
      if (!String(decode(r.stdout, r.exit, 'help').usage).includes(option)) throw new ClientError('CLI_INCOMPATIBLE', `核心 CLI 缺少 ${option}，需要包含 TUI 读取扩展的版本`);
    }
    if (this.options.review) {
      const result = await invoke(this.cli, ['issue', 'show', '--help', '--json'], this.options.cwd, this.options.timeout, this.options.signal);
      if (!String(decode(result.stdout, result.exit, 'help').usage).includes('--issue-version')) throw new ClientError('CLI_INCOMPATIBLE', '候选审阅需要支持 issue show --issue-version 的核心 CLI；旧版请加 --legacy 阅读需求');
    }
    this.config = this.options.config;
    const source = String((await this.raw('configPath', [])).config_path);
    this.config = source;
    const config = (await this.raw('configShow', [])).config as { database: { driver: string; expected_database_id: string } };
    this.directory = await this.temporary.open();
    this.config = join(this.directory, 'config.yaml');
    await writeFile(this.config, JSON.stringify(config), { mode: 0o600 });
    const db = await this.raw('dbTest', []);
    if (db.database_id !== config.database.expected_database_id) throw new ClientError('DATABASE_ID_MISMATCH', '数据库身份与会话配置不一致');
    this.context = { cli: this.cli, version: String(version.version), configSource: source, databaseId: String(db.database_id), driver: config.database.driver, cwd: this.options.cwd };
  }
  private async raw(method: Method, args: string[], signal?: AbortSignal): Promise<Data> {
    const argv = [...methods[method].args, ...args, '--json'];
    if (method !== 'version') {
      argv.push('--cwd', this.options.cwd);
      if (this.config) argv.push('--config', this.config);
    }
    const r = await invoke(this.cli, argv, this.options.cwd, this.options.timeout, signal ?? this.options.signal);
    return decode(r.stdout, r.exit, method);
  }
  async query(method: Method, args: string[] = [], signal?: AbortSignal): Promise<Data> {
    if (this.closed) throw new ClientError('CANCELLED', '已退出');
    if (this.running >= 2) await new Promise<void>(r => this.waiters.push(r));
    if (this.closed || signal?.aborted) { this.waiters.shift()?.(); throw new ClientError('CANCELLED', '已取消'); }
    this.running++;
    const controller = new AbortController();
    this.pending.add(controller);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try { return await this.raw(method, args, controller.signal); }
    finally { signal?.removeEventListener('abort', cancel); this.pending.delete(controller); this.running--; this.waiters.shift()?.(); }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const c of this.pending) c.abort();
    for (const r of this.waiters.splice(0)) r();
    await this.temporary.close(); this.directory = undefined;
  }
  async selectCandidate(request: SelectionRequest): Promise<Data> {
    if (this.closed) throw new ClientError('CANCELLED', '已退出');
    const args = ['selection', 'set', '--issue', request.issue, '--issue-version', String(request.version), '--candidate', request.candidate,
      '--expected-version', String(request.expectedVersion), '--operation-id', request.operationId, '--reason', request.reason,
      '--json', '--cwd', this.options.cwd, '--config', this.config!];
    // Deliberately separate from the read-only query interface. No automatic retry.
    const controller = new AbortController(); this.pending.add(controller);
    try {
      const result = await invoke(this.cli, args, this.options.cwd, this.options.timeout, controller.signal);
      return decode(result.stdout, result.exit, 'selectionSet');
    } finally { this.pending.delete(controller); }
  }
  async evalReady(): Promise<void> {
    this.evalChecked ??= (async () => {
      for (const argv of [['artifact', 'file'], ['grader', 'evidence-file'], ['grader', 'notices'], ['suite', 'tasks', 'publish']]) {
        const r = await invoke(this.cli, ['eval', ...argv, '--help', '--json'], this.options.cwd, this.options.timeout);
        if (r.exit !== 0 || !String(decode(r.stdout, r.exit, 'help').usage).includes(argv.join(' '))) {
          throw new ClientError('CLI_INCOMPATIBLE', 'Eval 工作台需要包含证据读取和 Grader notices 扩展的核心 CLI；请使用配套构建');
        }
      }
    })().catch(error => { this.evalChecked = undefined; throw new ClientError('CLI_INCOMPATIBLE', 'Eval 工作台需要配套核心 CLI（artifact file、grader evidence-file/notices）：' + String(error)); });
    return this.evalChecked;
  }
  async read(command: EvalRead, args: string[] = [], signal?: AbortSignal): Promise<unknown> {
    await this.evalReady();
    if (this.closed) throw new ClientError('CANCELLED', '已退出');
    if (this.running >= 2) await new Promise<void>(r => this.waiters.push(r));
    if (this.closed || signal?.aborted) { this.waiters.shift()?.(); throw new ClientError('CANCELLED', '已取消'); }
    this.running++;
    const controller = new AbortController(); this.pending.add(controller);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    try {
      const r = await invoke(this.cli, ['eval', ...command.split('.'), ...args, '--json', '--cwd', this.options.cwd, '--config', this.config!], this.options.cwd, this.options.timeout, controller.signal);
      return parseEvalEnvelope(r.stdout, r.exit, command);
    } finally { signal?.removeEventListener('abort', cancel); this.pending.delete(controller); this.running--; this.waiters.shift()?.(); }
  }
  async database(): Promise<string> { return String((await this.query('dbTest')).database_id); }
  async identity(): Promise<HumanIdentity> {
    const values = await Promise.all(['user.name', 'user.email'].map(key => invoke('git', ['config', '--get', key], this.options.cwd, this.options.timeout)));
    if (values.some(v => v.exit !== 0 || !v.stdout.trim())) throw new ClientError('HUMAN_IDENTITY_REQUIRED', '发布需要 Git user.name 和 user.email');
    return { kind: 'human', git_name: values[0].stdout.trim(), git_email: values[1].stdout.trim() };
  }
  async publish(request: FrozenPublication): Promise<EvalRecord> {
    await this.evalReady();
    if (this.closed) throw new ClientError('CANCELLED', '已退出');
    if (await this.database() !== request.databaseId) throw new ClientError('DATABASE_ID_MISMATCH', '待恢复操作属于另一账本，禁止重放');
    const directory = await this.temporary.request('eval-write');
    const controller = new AbortController(); this.pending.add(controller);
    try {
    const args = ['eval', ...request.command.split('.'), ...(request.id ? [request.id] : []), '--operation-id', request.operationId, '--json', '--cwd', this.options.cwd, '--config', this.config!];
    if (request.expectedVersion !== undefined) args.push('--expected-version', String(request.expectedVersion));
    if (request.taskId) args.push('--task', request.taskId);
    if (request.name !== undefined) args.push('--name', request.name);
    if (request.body) { const file = join(directory, 'input.json'); await writeFile(file, JSON.stringify(request.body), { mode: 0o600 }); args.push('--file', file); }
      const environment = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: request.attribution.git_name, GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: request.attribution.git_email };
      const result = await invoke(this.cli, args, this.options.cwd, this.options.timeout, controller.signal, environment);
      return fixedRecord(parseEvalEnvelope(result.stdout, result.exit, request.command), request.command.split('.')[0], request.id);
    } finally { this.pending.delete(controller); await this.temporary.release(directory); }
  }
  async qaDraft(command: string, args: string[] = [], body?: Data): Promise<unknown> {
    const allowed = ['draft.list', 'draft.show', 'draft.status', 'draft.evidence', 'draft.edit', 'draft.split', 'draft.merge', 'draft.route-suggestion', 'draft.resolve-boundary', 'draft.preview', 'draft.publish', 'draft.resume', 'draft.cancel', 'draft.save-source', 'draft.export-public', 'source-package.show', 'source-package.file', 'clue.list', 'clue.show', 'clue.ignore'];
    if(this.closed)throw new ClientError('CANCELLED','已退出');
    if (!allowed.includes(command)) throw new ClientError('VALIDATION_ERROR', '未知草稿动作');
    await this.evalReady();
    const directory = await this.temporary.request('qa-draft');
    const controller = new AbortController(); this.pending.add(controller);
    try {
    const argv = ['eval', ...command.split('.'), ...args, '--json', '--cwd', this.options.cwd, '--config', this.config!];
    let environment = process.env;
    if (command === 'draft.publish' || command === 'draft.save-source') {
      const human = await this.identity();
      environment = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: human.git_name, GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: human.git_email };
      argv.push('--operation-id', operationId());
    }
    if (body) { const file = join(directory, 'input.json'); await writeFile(file, JSON.stringify(body), { mode: 0o600 }); argv.push('--file', file); }
      const result = await invoke(this.cli, argv, this.options.cwd, this.options.timeout, controller.signal, environment);
      let value: any; try { value = JSON.parse(result.stdout); } catch { throw new ClientError('PROTOCOL_ERROR', '草稿接口未返回有效 JSON'); }
      if (value.format !== 'patchledger.cli/v1' || typeof value.ok !== 'boolean') throw new ClientError('PROTOCOL_ERROR', '草稿协议不兼容');
      if (!value.ok) throw new ClientError(value.error?.code ?? 'PROTOCOL_ERROR', `${value.error?.message ?? '操作失败'} · ${JSON.stringify(value.error?.details ?? {})}`);
      if (result.exit !== 0 || value.data?.result_type !== 'patchledger.result.eval/v1' || value.data.command !== `eval.${command}` || !('payload' in value.data)) throw new ClientError('PROTOCOL_ERROR', '草稿返回类型不匹配');
      const payload = value.data.payload;
      const objectValue = (v: unknown): v is Data => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
      const draftValue = (v: unknown) => objectValue(v) && v.format === 'grounds.qa-draft/v1' && typeof v.id === 'string' && Number.isSafeInteger(v.version) && Number(v.version) > 0;
      const digestValue = (v: unknown) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
      const clueValue = (v: unknown) => objectValue(v) && v.format === 'grounds.source-clue-record/v1' && typeof v.id === 'string' && Number.isSafeInteger(v.version) && objectValue(v.source) && ['pending_analysis','expired','ignored'].includes(String(v.state));
      const valid = command === 'clue.list' ? objectValue(payload) && payload.format === 'grounds.source-clue-list/v1' && Array.isArray(payload.clues) && payload.clues.every(clueValue) : ['clue.show','clue.ignore'].includes(command) ? clueValue(payload) : command==='draft.export-public'?objectValue(payload)&&payload.format==='grounds.eval-public-question/v1'&&objectValue(payload.qa)&&typeof payload.question==='string'&&typeof payload.instructions==='string':command === 'draft.list' ? objectValue(payload) && payload.format === 'grounds.qa-draft-list/v1' && Array.isArray(payload.drafts) && payload.drafts.every((d: unknown) => objectValue(d) && typeof d.id === 'string' && Number.isSafeInteger(d.version)) :
        command === 'draft.show' ? objectValue(payload) && draftValue(payload.draft) && objectValue(payload.qa) && Array.isArray(payload.materials) && Array.isArray(payload.missing) :
          command === 'draft.status' ? objectValue(payload) && payload.format === 'grounds.qa-draft-status/v1' && payload.draft_id === args[0] :
            command === 'draft.preview' ? objectValue(payload) && payload.format === 'grounds.qa-draft-preview/v1' && payload.draft_id === args[0] && digestValue(payload.digest) && payload.database_id === await this.database() :
              command === 'source-package.show' ? objectValue(payload) && payload.format === 'grounds.qa-source-package-reference/v1' && payload.digest === args[0] && Array.isArray(payload.evidence) :
                command === 'draft.evidence' || command === 'source-package.file' ? objectValue(payload) && payload.encoding === 'base64' && digestValue(payload.digest) && Number.isSafeInteger(payload.offset) && Number.isSafeInteger(payload.size) && typeof payload.content === 'string' :
                  command === 'draft.split' ? Array.isArray(payload) && payload.every(draftValue) :
                    command === 'draft.save-source' ? objectValue(payload) && draftValue(payload.draft) && objectValue(payload.source_package) && digestValue(payload.source_package.digest) : draftValue(payload);
      if (!valid) throw new ClientError('PROTOCOL_ERROR', '草稿返回缺少必要身份、版本或状态字段');
      return payload;
    } finally { this.pending.delete(controller); await this.temporary.release(directory); }
  }
  async selectionIdentity(): Promise<string> {
    const values = await Promise.all(['user.name', 'user.email'].map(key => invoke('git', ['config', '--get', key], this.options.cwd, this.options.timeout)));
    if (values.some(v => v.exit !== 0 || !v.stdout.trim())) throw new ClientError('HUMAN_IDENTITY_REQUIRED', '人工选择需要 Git user.name 和 user.email');
    return `${values[0].stdout.trim()} <${values[1].stdout.trim()}>`;
  }
}
