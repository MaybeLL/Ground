import { spawn } from 'node:child_process';
import { access, readFile, writeFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { ClientTemporaryFiles } from './client-temp.js';
import { ClientError, decode, methods, type Data, type Method } from './protocol.js';

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

export class Client implements Reader {
  context!: Context;
  private directory?: string;
  private config?: string;
  private running = 0;
  private waiters: (() => void)[] = [];
  private pending = new Set<AbortController>();
  private closed = false;
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
  async selectionIdentity(): Promise<string> {
    const values = await Promise.all(['user.name', 'user.email'].map(key => invoke('git', ['config', '--get', key], this.options.cwd, this.options.timeout)));
    if (values.some(v => v.exit !== 0 || !v.stdout.trim())) throw new ClientError('HUMAN_IDENTITY_REQUIRED', '人工选择需要 Git user.name 和 user.email');
    return `${values[0].stdout.trim()} <${values[1].stdout.trim()}>`;
  }
}
