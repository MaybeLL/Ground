import { Marked, type Token, type Tokens } from 'marked';
import { Chalk } from 'chalk';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';

const parser = new Marked({ gfm: true });
const style = new Chalk({ level: process.env.NO_COLOR === undefined ? 1 : 0 });
// Only renderer-generated styling may reach the terminal. Never execute HTML,
// load images, or turn document links into terminal escape sequences.
export const clean = (value: string) => stripAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const decoded = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, x => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[x]!);
const proseQuote = (value: string) => /[\p{Script=Han}]/u.test(value) && /\s/u.test(value) && !/[=()[\]{};\\/]/u.test(value);
const inline = (tokens: Token[] = [], review = false): string => tokens.map((token, index) => {
  switch (token.type) {
    case 'text': {
      const value = decoded(token.text);
      const previous = tokens[index - 1];
      // A quoted slogan may already end the sentence inside its backticks.
      return review && previous?.type === 'codespan' && proseQuote(decoded(previous.text)) && previous.text.endsWith('.') && value.startsWith('.') ? value.slice(1) : value;
    }
    case 'strong': return style.bold(inline(token.tokens, review));
    case 'em': return style.italic(inline(token.tokens, review));
    case 'del': return style.strikethrough(inline(token.tokens, review));
    case 'codespan': {
      const value = decoded(token.text);
      // Agents also use backticks to quote product copy. In review prose, render
      // mixed Chinese phrases as quotations rather than executable-looking code.
      return review && proseQuote(value) ? `「${value}」` : style.yellow(value);
    }
    case 'link': {
      const label = inline(token.tokens, review);
      return style.cyan.underline(label) + (stripAnsi(label) === token.href ? '' : style.dim(` (${token.href})`));
    }
    case 'image': return `[图片: ${token.text || '未命名'}] (${token.href})`;
    case 'br': return '\n';
    case 'escape': return decoded(token.text);
    case 'html': return token.text;
    default: return 'tokens' in token && token.tokens ? inline(token.tokens as Token[], review) : 'text' in token ? decoded(String(token.text)) : token.raw;
  }
}).join('');

const wrap = (text: string, width: number): string[] => wrapAnsi(text, Math.max(1, width), { hard: true, trim: false }).split('\n');
const cell = (value: Tokens.TableCell, review: boolean) => inline(value.tokens, review).replace(/\n/g, ' ');
function table(token: Tokens.Table, width: number, review: boolean): string[] {
  const headers = token.header.map(value => cell(value, review));
  const rows = token.rows.map(row => row.map(value => cell(value, review)));
  const columns = headers.length;
  const available = width - columns * 3 - 1;
  // Preserve readable cells on a narrow terminal instead of clipping columns.
  if (available < columns * 8) return rows.flatMap((row, i) => [style.dim(`记录 ${i + 1}`), ...row.flatMap((value, j) => wrap(`${style.bold(headers[j])}: ${value}`, width)), '']);
  const sizes = headers.map((header, j) => Math.min(available, rows.reduce((n, row) => Math.max(n, stringWidth(row[j] ?? '')), Math.max(2, stringWidth(header)))));
  while (sizes.reduce((a, b) => a + b, 0) > available) {
    const longest = sizes.indexOf(Math.max(...sizes)); sizes[longest]!--;
  }
  const border = (left: string, middle: string, right: string) => style.dim(left + sizes.map(n => '─'.repeat(n + 2)).join(middle) + right);
  const renderRow = (row: string[], header = false): string[] => {
    const cells = row.map((value, j) => wrap(header ? style.bold(value) : value, sizes[j]!));
    return Array.from({ length: Math.max(...cells.map(lines => lines.length)) }, (_, i) => '│' + cells.map((lines, j) => {
      const text = lines[i] ?? '', padding = Math.max(0, sizes[j]! - stringWidth(text));
      const alignment = token.align[j];
      const left = alignment === 'right' ? padding : alignment === 'center' ? Math.floor(padding / 2) : 0;
      return ` ${' '.repeat(left)}${text}${' '.repeat(padding - left)} `;
    }).join('│') + '│');
  };
  return [border('┌', '┬', '┐'), ...renderRow(headers, true), border('├', '┼', '┤'), ...rows.flatMap(row => renderRow(row)), border('└', '┴', '┘'), ''];
}

function blocks(tokens: Token[] | undefined, width: number, review = false): string[] {
  return (tokens ?? []).flatMap(token => {
    switch (token.type) {
      case 'space': return [''];
      case 'heading': {
        const heading = inline(token.tokens, review);
        const color = review && /实现|交付|代码/.test(token.text) ? style.magentaBright : review && /要求|目标|约束|标准|契约/.test(token.text) ? style.blueBright : style.cyan;
        return [...wrap(color.bold(heading), width), ''];
      }
      case 'paragraph': return [...wrap(inline(token.tokens, review), width), ''];
      case 'text': return wrap(inline([token], review), width);
      case 'code': return [...wrap(style.dim(`┌─ ${token.lang || '代码'}`), width), ...String(token.text).split('\n').flatMap(line => wrap(style.yellow(line.replace(/\t/g, '    ')), width - 2).map(s => style.dim('│ ') + s)), style.dim('└' + '─'.repeat(Math.max(0, width - 1))), ''];
      case 'blockquote': return blocks(token.tokens, width - 2, review).map(line => style.dim('│ ') + line);
      case 'list': return (token as Tokens.List).items.flatMap((item, i) => {
        const prefix = item.task ? (item.checked ? '☑ ' : '☐ ') : token.ordered ? `${Number(token.start) + i}. ` : '• ';
        const indent = stringWidth(prefix);
        const content = blocks(item.tokens, width - indent, review);
        while (content.at(-1) === '') content.pop();
        return content.map((line, n) => (n === 0 ? prefix : ' '.repeat(indent)) + line);
      }).concat('');
      case 'table': return table(token as Tokens.Table, width, review);
      case 'hr': return [style.dim('─'.repeat(width)), ''];
      case 'html': return wrap(token.text, width);
      default: return wrap(token.raw, width);
    }
  });
}

/** Parse before viewport slicing so a scrolled table/code block retains context. */
export function renderMarkdown(lines: string[], width: number, review = false): string[] {
  const text = clean(lines.join('\n'));
  const safeWidth = Math.max(8, Math.floor(width));
  try {
    const result = blocks(parser.lexer(text), safeWidth, review);
    while (result.at(-1) === '') result.pop();
    return result.length ? review ? result.filter((line, index) => line !== '' || index === 0 || result[index - 1] !== '') : result : [''];
  } catch {
    // Incomplete or pathological Markdown must remain readable.
    return wrap(text, safeWidth);
  }
}

/** Retain only the viewport; large rendered documents never become Page.lines. */
export function markdownWindow(lines: string[], width: number, offset: number, height: number): { lines: string[]; total: number } {
  const source = clean(lines.join('\n')), safeWidth = Math.max(8, Math.floor(width));
  let total = 0, trailing = 0; const visible: string[] = [];
  const consume = (chunk: string[]) => { for (const line of chunk) {
    if (total >= offset && total < offset + height) visible.push(line);
    total++; trailing = line === '' ? trailing + 1 : 0;
  } };
  try { for (const token of parser.lexer(source)) consume(blocks([token], safeWidth)); }
  catch { total = 0; trailing = 0; visible.length = 0; consume(wrap(source, safeWidth)); }
  return { lines: visible.slice(0, Math.max(0, total - trailing - offset)), total: Math.max(1, total - trailing) };
}

/** Locate matches and headings without retaining a second full rendered document. */
export function markdownLocations(lines: string[], width: number, query: string): { matches: number[]; chapters: number[] } {
  const matches = new Set<number>(), chapters: number[] = [];
  const needle = clean(query).toLowerCase();
  let offset = 0;
  for (const token of parser.lexer(clean(lines.join('\n')))) {
    const chunk = blocks([token], Math.max(8, Math.floor(width)));
    if (token.type === 'heading') chapters.push(offset);
    if (needle) {
      const plain = chunk.map(line => stripAnsi(line).toLowerCase());
      const joined = plain.join('');
      let start = 0, at = joined.indexOf(needle);
      for (let line = 0; line < plain.length && at >= 0; line++) {
        const end = start + plain[line]!.length;
        while (at >= start && at < end) { matches.add(offset + line); at = joined.indexOf(needle, at + Math.max(1, needle.length)); }
        start = end;
      }
    }
    offset += chunk.length;
  }
  return { matches: [...matches], chapters };
}
