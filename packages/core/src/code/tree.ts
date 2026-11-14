/*
 * The shared shape of a script. The text syntaxes (C#-style and Python-style) and the Scratch blocks are
 * all views of this tree, so converting between them never loses anything.
 */

/** A value plugged into a block: a typed-in literal, or another block that sits on top of it. */
export type Input = { lit: string } | { node: Node };

/** Custom block (procedure) details, on both the definition and every call. */
export interface Proc {
  /** Scratch's own label, e.g. "jump %s times %b". */
  proccode: string;
  /** One entry per argument, in order. */
  argNames: string[];
  warp: boolean;
}

export interface Node {
  op: string;
  /** Plain dropdown / name fields. Variable and list names live here too (VARIABLE, LIST). */
  fields: Record<string, string>;
  /** Inputs by name. Custom block calls use "0", "1", ... in argument order. */
  inputs: Record<string, Input>;
  /** Blocks wrapped by a C-shaped block (SUBSTACK, SUBSTACK2). */
  stacks: Record<string, Node[]>;
  proc?: Proc;
}

export interface Script {
  nodes: Node[];
  x: number;
  y: number;
  /** Id of the first block when this came from a project (used to match scripts up again). */
  id?: string;
}

export interface VarDecl {
  name: string;
  type: 'var' | 'list';
  local: boolean;
  cloud: boolean;
}

export const node = (op: string): Node => ({ op, fields: {}, inputs: {}, stacks: {} });

export const procArgTypes = (proccode: string): ('s' | 'b')[] => {
  const out: ('s' | 'b')[] = [];
  for (const m of proccode.matchAll(/%([sb])/g)) out.push(m[1] as 's' | 'b');
  return out;
};
