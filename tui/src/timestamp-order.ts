/** Sort UTC timestamps without losing sub-millisecond precision or treating
 * equivalent fractional spellings as different instants. Unknown values keep
 * their previous lexical ordering so older incomplete data remains usable. */
export function timestampOrderKey(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  return match ? match[1] + (match[2] ?? '').padEnd(9, '0') : value;
}
