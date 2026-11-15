/** Where things are drawn in the code editor (the text uses a fixed-width font, so a spot is a line and a column). */

export const TAB_SIZE = 4;

export interface Metrics {
  /** Width of one character. */
  char: number;
  /** Height of one line. */
  line: number;
  /** Where text starts, from the left and top of the editor area. */
  padLeft: number;
  padTop: number;
}

/** The column a piece of a line ends at, counting a tab as the jump to the next multiple of TAB_SIZE. */
export function visualColumn(text: string): number {
  let col = 0;
  for (const ch of text) col = ch === '\t' ? (Math.floor(col / TAB_SIZE) + 1) * TAB_SIZE : col + 1;
  return col;
}

/** Line (0-based) and visual column for a character offset in `value`. */
export function lineAndColumn(value: string, offset: number): { line: number; col: number } {
  const before = value.slice(0, Math.max(0, Math.min(offset, value.length)));
  const start = before.lastIndexOf('\n') + 1;
  let line = 0;
  for (let i = 0; i < start; i++) if (before.charCodeAt(i) === 10) line++;
  return { line, col: visualColumn(before.slice(start)) };
}

/** Measure the editor's font. `layer` is the element the text sits in, `input` the text box. */
export function measureMetrics(input: HTMLElement, layer: HTMLElement): Metrics {
  const probe = document.createElement('span');
  probe.className = 'cw-code-text';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;padding:0;left:0;top:0';
  probe.textContent = 'M'.repeat(100);
  layer.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();
  const style = getComputedStyle(input);
  return {
    char: width > 0 ? width : 8,
    line: parseFloat(style.lineHeight) || 20,
    padTop: parseFloat(style.paddingTop) || 10,
    padLeft: input.offsetLeft + (parseFloat(style.paddingLeft) || 12),
  };
}
