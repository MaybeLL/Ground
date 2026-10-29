interface PreviewSection {
  header: readonly string[];
  blocks: readonly (readonly string[])[];
  total: number;
  label: string;
}

/** Internal presentation seam: select whole, already-escaped blocks in order.
 * Budgets include every heading, the exact remaining counts and the separator
 * before details. Neither the inputs nor the rendered blocks are truncated.
 */
export const renderMarkdownPreview = (
  intro: readonly string[],
  sections: readonly PreviewSection[],
  limits = { characters: 4000, lines: 50 },
): string[] => {
  const shown = sections.map(() => 0);
  const render = (): string[] => [
    ...intro,
    ...sections.flatMap((section, index) => [
      ...section.header,
      ...section.blocks.slice(0, shown[index]).flat(),
    ]),
    `Remaining in details: ${sections.map((section, index) => `${section.total - shown[index]} ${section.label}`).join("; ")}.`,
  ];
  const fits = (lines: string[]): boolean => {
    const text = lines.join("\n") + "\n\n";
    return [...text].length <= limits.characters && text.split("\n").length <= limits.lines;
  };
  if (!fits(render())) throw new RangeError("Required Markdown review signals exceed the preview budget");
  for (let index = 0; index < sections.length; index++) {
    for (const _block of sections[index].blocks) {
      shown[index]++;
      if (!fits(render())) { shown[index]--; break; }
    }
  }
  return render();
};
