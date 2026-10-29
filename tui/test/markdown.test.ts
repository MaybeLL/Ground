import { test } from 'node:test';
import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { markdownWindow, renderMarkdown } from '../src/markdown.js';
import { describe } from '../src/pages.js';

test('Markdown headings, inline styles, tasks, links and literal code retain content', () => {
  const lines = renderMarkdown(['# 规则标题', '', '**重点** 和 `field_name`', '', '- [x] 已完成', '- [ ] 待完成', '', '> 引用内容', '', '[文档](https://example.test)', '', '```go', '  x := "**literal**"', '```'], 50);
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /规则标题/); assert.doesNotMatch(text, /# 规则标题|\*\*重点\*\*|`field_name`|```/);
  assert.match(text, /☑ 已完成/); assert.match(text, /☐ 待完成/);
  assert.match(text, /│ 引用内容/); assert.match(text, /https:\/\/example.test/);
  assert.match(text, /│   x := "\*\*literal\*\*"/);
});

test('Chinese GFM tables wrap cells to viewport width and stack on narrow screens', () => {
  const source = ['| selector字段 | 契约 |', '| --- | --- |', '| example_code | 正整数，不接受小数，保留全部中文内容 |', '| item_count | 非负整数 |'];
  const wide = renderMarkdown(source, 45);
  assert.match(stripAnsi(wide.join('\n')), /┌.*┬.*┐/);
  assert.ok(wide.every(line => stringWidth(line) <= 45));
  assert.match(stripAnsi(wide.join('')).replace(/[│\s]/g, ''), /正整数，不接受小数，保留全部中文内容/);
  const narrow = renderMarkdown(source, 20);
  assert.match(stripAnsi(narrow.join('\n')), /记录 1/);
  assert.ok(narrow.every(line => stringWidth(line) <= 20));
  assert.match(stripAnsi(narrow.join('')), /example_code/);
});

test('nested multiline business fields preserve heading and table Markdown boundaries', () => {
  const lines = describe({ decisions: [{ details: { context: '#### 示例规则\n\n| 字段 | 契约 |\n| --- | --- |\n| item_count | 非负整数 |' } }] });
  const result = stripAnsi(renderMarkdown(lines, 55).join('\n'));
  assert.match(result, /示例规则/); assert.doesNotMatch(result, /####|\| ---/); assert.match(result, /┌/);
});

test('untrusted control sequences cannot reach terminal through Markdown or links', () => {
  const result = stripAnsi(renderMarkdown(['# title\u001b[2J', '', '[safe](https://example.test/\u001b]52;c;secret\u0007)', '', '```', '\u009b2Jraw\u0007', '```'], 60).join('\n'));
  assert.doesNotMatch(result, /[\x00-\x08\x1b\x7f-\x9f]/);
  assert.doesNotMatch(result, /secret/);
});

test('bounded Markdown windows retain table and code semantics at every offset', () => {
  const source = ['# 标题', '', '| 字段 | 说明 |', '| --- | --- |', '| a | 正文 |', '', '```ts', 'const value = 42;', '```', '', ...Array.from({ length: 100 }, (_, i) => `段落 ${i}\n`)];
  const full = renderMarkdown(source, 60);
  for (const offset of [0, 2, 5, 10, 100]) {
    const window = markdownWindow(source, 60, offset, 10);
    assert.deepEqual(window.lines, full.slice(offset, offset + 10)); assert.equal(window.total, full.length); assert.ok(window.lines.length <= 10);
  }
});

test('reading locations match wrapped Chinese prose and rendered heading offsets', async () => {
  const { markdownLocations } = await import('../src/markdown.js');
  const source = ['# 第一章', '', '中文精度需要保留所有数值', '', '## 第二章', '', '其他内容'];
  const rendered = renderMarkdown(source, 8);
  const locations = markdownLocations(source, 8, '需要保留');
  assert.equal(locations.matches.length, 1);
  assert.match(stripAnsi(rendered[locations.matches[0]!]!), /需要/);
  assert.deepEqual(locations.chapters.map(i => stripAnsi(rendered[i]!)), ['第一章', '第二章']);
});
