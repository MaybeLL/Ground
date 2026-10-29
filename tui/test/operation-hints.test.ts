import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { operationHintLines } from '../src/operation-hints.js';

test('operation hints keep every shortcut visible or point to the complete list in a small viewport', () => {
  const commands = ['按 Tab 切换页签', '1/2 直达', 'Enter/→ 查看详情', 'd 关联代码', 'v 复核详情', 'e 证据', 'i 标识', '↑↓ 浏览', '? 帮助', 'q 退出'];
  const roomy = operationHintLines(commands, 80, 5);
  assert.ok(roomy.every(line => stringWidth(line) <= 80));
  for (const command of commands) assert.ok(roomy.join(' ').includes(command), command);
  const compact = operationHintLines(commands, 40, 1);
  assert.ok(compact.every(line => stringWidth(line) <= 40));
  assert.match(compact.join(' '), /\? 查看全部操作/);
});
