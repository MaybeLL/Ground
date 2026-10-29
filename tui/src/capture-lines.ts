import stringWidth from 'string-width';
import { Chalk } from 'chalk';
import { clean } from './markdown.js';
import type { Data } from './protocol.js';

/** Presentation helpers shared by the captured-QA review views.
 * Everything here returns finished terminal lines no wider than `width`, so the
 * caller can slice them for scrolling without re-wrapping CJK text. */
export const paint = new Chalk({ level: process.env.NO_COLOR === undefined ? 1 : 0 });
export const obj = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
export const list = (v: unknown): Data[] => Array.isArray(v) ? v.map(obj) : [];
export const text = (v: unknown): string => typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
export const strings = (v: unknown): string[] => Array.isArray(v) ? v.map(text).filter(s => s.trim()) : [];

const CLOSING = new Set('，。、；：！？）」』》〉】”’,.;:!?)]}%'), OPENING = new Set('（「『《〈【“‘([{');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Break one plain line by terminal cells. Prefers a nearby space, otherwise breaks
 * between any two glyphs (CJK has no spaces), and keeps closing punctuation off
 * the start of a line and opening brackets off the end. */
function breakLine(line: string, room: number): string[] {
  const glyphs = [...segmenter.segment(line)].map(part => part.segment), widths = glyphs.map(g => stringWidth(g));
  const out: string[] = []; let start = 0;
  while (start < glyphs.length) {
    let used = 0, end = start;
    while (end < glyphs.length && used + widths[end]! <= room) { used += widths[end]!; end++; }
    if (end >= glyphs.length) { out.push(glyphs.slice(start).join('')); break; }
    let cut = end;
    let space = -1;
    for (let back = end - 1, span = 0; back > start && span <= 12; back--) { span += widths[back]!; if (glyphs[back] === ' ') { space = back; break; } }
    if (space > start && glyphs[end] !== ' ') cut = space + 1;
    else if (CLOSING.has(glyphs[cut]!) && cut - 1 > start) cut -= 1;
    else if (OPENING.has(glyphs[cut - 1]!) && cut - 1 > start) cut -= 1;
    if (cut <= start) cut = Math.max(start + 1, end);
    out.push(glyphs.slice(start, cut).join('').replace(/ +$/, ''));
    start = cut; while (glyphs[start] === ' ' && start < glyphs.length) start++;
  }
  return out.length ? out : [''];
}

/** Wrap prose by terminal cells. User text is stripped of control sequences and
 * never interpreted as Markdown, so `*`, `#` or backticks stay literal. */
export function wrapBlock(value: string, width: number, prefix = '', rest = prefix): string[] {
  const room = Math.max(4, width - Math.max(stringWidth(prefix), stringWidth(rest)));
  const lines = clean(value).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
    .flatMap(line => line.trim() === '' ? [''] : breakLine(line, room));
  return lines.map((line, index) => (index === 0 ? prefix : rest) + line);
}

/** Keep at most `max` wrapped lines and say how many were left out. */
export function limitLines(lines: string[], max: number, more: (hidden: number) => string): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), more(lines.length - max)];
}

export const rule = (width: number, label = ''): string => {
  const head = label ? `── ${clean(label)} ` : '';
  return paint.dim(head + '─'.repeat(Math.max(0, width - stringWidth(head))));
};

/** Clip to a number of terminal cells without splitting a double-width glyph. */
export function clipCells(value: string, width: number): string {
  const flat = clean(value).replace(/\s+/g, ' ').trim();
  if (stringWidth(flat) <= width) return flat;
  let out = '';
  for (const char of flat) { if (stringWidth(out + char) > Math.max(1, width - 1)) break; out += char; }
  return out + '…';
}

export function shortId(id: string): string { return id.slice(0, 8); }
