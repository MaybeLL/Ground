#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from './client.js';
import { ClientError } from './protocol.js';
import { App, clean } from './app.js';
import { Workbench } from './workbench.js';

let client: Client | undefined;
try {
  const { values } = parseArgs({ options: { cli: { type: 'string' }, cwd: { type: 'string' }, config: { type: 'string' },
    'query-timeout': { type: 'string' }, legacy: { type: 'boolean' }, eval: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' } } });
  if (values.help) {
    console.log('grounds-tui [--cli PATH] [--cwd DIR] [--config FILE] [--query-timeout SECONDS] [--legacy | --eval]\n默认首页左右选择需求开发或评测；←/→/Tab 选择，Enter 进入。--eval 直接打开评测；开发工作台 Ctrl+E 切换、Ctrl+G 返回首页。Candidate 审阅工作台；确认后可记录人工 Selection。--legacy 打开原需求阅读。macOS/Linux。');
  } else if (values.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('主界面需要交互式终端；脚本请使用 grounds --json');
    if (values.legacy && values.eval) throw new Error('--legacy 与 --eval 不能同时使用');
    const seconds = Number(values['query-timeout'] ?? 30);
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400) throw new Error('--query-timeout 需要 1–86400 秒的整数');
    console.error('正在连接 Grounds…');
    const connecting = new AbortController();
    const cancelConnection = () => connecting.abort();
    process.once('SIGTERM', cancelConnection); process.once('SIGINT', cancelConnection);
    try {
      client = await Client.open({ cli: values.cli, cwd: resolve(values.cwd ?? process.cwd()), config: values.config ? resolve(values.config) : undefined, timeout: seconds * 1000, signal: connecting.signal, review: !values.legacy });
    } finally { process.off('SIGTERM', cancelConnection); process.off('SIGINT', cancelConnection); }
    process.stdout.write('\u001b[?1049h');
    let restoreDone = false;
    const restore = () => { if (!restoreDone) { process.stdout.write('\u001b[?1049l\u001b[?25h'); restoreDone = true; } };
    process.once('exit', restore);
    const view = values.legacy ? <App reader={client} context={client.context} onExit={() => instance.unmount()} /> : <Workbench client={client} startEval={Boolean(values.eval)} onExit={() => instance.unmount()} />;
    // The launcher requires a real TTY above. Keep it interactive even when a
    // terminal is opened by CI; Ink otherwise suppresses frames until exit.
    const instance = render(view, { exitOnCtrlC: false, incrementalRendering: true, interactive: true });
    const stop = () => instance.unmount();
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { await instance.waitUntilExit(); }
    finally { instance.unmount(); restore(); process.off('exit', restore); process.off('SIGTERM', stop); process.off('SIGINT', stop); }
  }
} catch (e) {
  console.error(clean(e instanceof ClientError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally { await client?.close(); }
