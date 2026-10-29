import stringWidth from 'string-width';

// Keep whole shortcuts together so wrapping never hides the key from its action.
export function operationHintLines(parts: string[], width: number, maxRows: number, overflow = '? 查看全部操作'): string[] {
  const prefix = ' 操作 │ ';
  const continuation = ' '.repeat(stringWidth(prefix));
  const lines: string[] = [prefix];
  for (const part of parts) {
    const current = lines.at(-1)!;
    const next = current === prefix || current === continuation ? part : ` · ${part}`;
    if (stringWidth(current + next) <= width) lines[lines.length - 1] += next;
    else if (lines.length < maxRows) lines.push(continuation + part);
    else {
      const suffix = ` · ${overflow}`;
      let last = lines.at(-1)!;
      while (stringWidth(last + suffix) > width && last.includes(' · ')) last = last.slice(0, last.lastIndexOf(' · '));
      lines[lines.length - 1] = stringWidth(last + suffix) <= width ? last + suffix : prefix + overflow;
      return lines;
    }
  }
  return lines;
}
