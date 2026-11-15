import { parse, type ParseError } from './parse';
import { printItems, type Item } from './print';
import type { Skin } from './spec';
import type { Proc } from './tree';

export type Conversion = { ok: true; text: string } | { ok: false; errors: ParseError[] };

/** Write code that is valid in the style `from` out again in the style `to` (the meaning stays the same). */
export function convertText(source: string, from: Skin, to: Skin, externalProcs: Proc[] = []): Conversion {
  const result = parse(source, { skin: from, externalProcs });
  if (result.errors.length > 0) return { ok: false, errors: result.errors };
  const items: Item[] = result.scripts.map((script) => ({ script }));
  // "kept" lines stand for scripts text cannot write yet; carry them over.
  for (const m of source.matchAll(/^[ \t]*(?:\/\/|#)[ \t]*kept:[ \t]*(\S+)[ \t]*(?:\((.*)\))?[ \t]*$/gm)) {
    items.push({ kept: { id: m[1], label: m[2] ?? '', x: 0, y: 0 } });
  }
  return { ok: true, text: printItems(items, result.decls, to) };
}
