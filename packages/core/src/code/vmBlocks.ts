import { BY_OP } from './spec';
import type { Item } from './print';
import { type Input, type Node, node } from './tree';

/** A block the way scratch-vm keeps it in `target.blocks._blocks`. */
export interface VmBlock {
  id?: string;
  opcode: string;
  next?: string | null;
  parent?: string | null;
  topLevel?: boolean;
  shadow?: boolean;
  x?: number;
  y?: number;
  inputs?: Record<string, { name?: string; block?: string | null; shadow?: string | null }>;
  fields?: Record<string, { name?: string; value?: unknown; id?: string }>;
  mutation?: Record<string, unknown> | null;
}

class Unsupported extends Error {
  constructor(readonly op: string) {
    super(op);
  }
}

const parseList = (value: unknown): string[] => {
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list) ? list.map((v) => String(v)) : [];
  } catch {
    return [];
  }
};

const truthy = (v: unknown): boolean => v === true || v === 'true';

class Reader {
  constructor(private readonly blocks: Record<string, VmBlock>) {}

  private field(b: VmBlock, name: string): string {
    const v = b.fields?.[name]?.value;
    return v === undefined || v === null ? '' : String(v);
  }

  input(inp: { block?: string | null; shadow?: string | null } | undefined): Input | undefined {
    if (!inp) return undefined;
    const top = inp.block ? this.blocks[inp.block] : undefined;
    const shadow = inp.shadow ? this.blocks[inp.shadow] : undefined;
    if (top && inp.block !== inp.shadow) return { node: this.node(inp.block!) };
    const lit = shadow ?? top;
    if (!lit) return undefined;
    const first = Object.values(lit.fields ?? {})[0];
    return { lit: first && first.value !== undefined && first.value !== null ? String(first.value) : '' };
  }

  chain(id: string | null | undefined): Node[] {
    const out: Node[] = [];
    let at = id ?? null;
    const seen = new Set<string>();
    while (at && this.blocks[at] && !seen.has(at)) {
      seen.add(at);
      out.push(this.node(at));
      at = this.blocks[at].next ?? null;
    }
    return out;
  }

  node(id: string): Node {
    const b = this.blocks[id];
    const op = b.opcode;
    const n = node(op);
    const spec = BY_OP.get(op);
    if (spec) {
      for (const a of spec.args) {
        if (a.kind === 'field' || a.kind === 'bfield' || a.kind === 'var' || a.kind === 'list') n.fields[a.name] = this.field(b, a.name);
        else if (a.kind === 'stack') n.stacks[a.name] = this.chain(b.inputs?.[a.name]?.block);
        else {
          const input = this.input(b.inputs?.[a.name]);
          if (input) n.inputs[a.name] = input;
        }
      }
      if (op === 'control_if_else') n.stacks.SUBSTACK2 ??= [];
      return n;
    }
    switch (op) {
      case 'data_setvariableto':
      case 'data_changevariableby': {
        n.fields.VARIABLE = this.field(b, 'VARIABLE');
        const input = this.input(b.inputs?.VALUE);
        if (input) n.inputs.VALUE = input;
        return n;
      }
      case 'data_variable':
        n.fields.VARIABLE = this.field(b, 'VARIABLE');
        return n;
      case 'data_listcontents':
        n.fields.LIST = this.field(b, 'LIST');
        return n;
      case 'argument_reporter_string_number':
      case 'argument_reporter_boolean':
        n.fields.VALUE = this.field(b, 'VALUE');
        return n;
      case 'procedures_definition': {
        const proto = this.blocks[b.inputs?.custom_block?.block ?? b.inputs?.custom_block?.shadow ?? ''];
        if (!proto?.mutation) throw new Unsupported(op);
        n.proc = { proccode: String(proto.mutation.proccode ?? ''), argNames: parseList(proto.mutation.argumentnames), warp: truthy(proto.mutation.warp) };
        return n;
      }
      case 'procedures_call': {
        const m = b.mutation;
        if (!m) throw new Unsupported(op);
        const ids = parseList(m.argumentids);
        n.proc = { proccode: String(m.proccode ?? ''), argNames: [], warp: truthy(m.warp) };
        ids.forEach((argId, i) => {
          const input = this.input(b.inputs?.[argId]);
          if (input) n.inputs[String(i)] = input;
        });
        return n;
      }
    }
    throw new Unsupported(op);
  }
}

/** Everything in a sprite's blocks as scripts, in reading order (top to bottom, left to right). */
export function readItems(blocks: Record<string, VmBlock>): Item[] {
  const reader = new Reader(blocks);
  const tops = Object.entries(blocks)
    .filter(([, b]) => b.topLevel && !b.shadow)
    .map(([id, b]) => ({ id, b, x: Math.round(b.x ?? 0), y: Math.round(b.y ?? 0) }))
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const items: Item[] = [];
  for (const { id, b, x, y } of tops) {
    try {
      const spec = BY_OP.get(b.opcode);
      const isHat = b.opcode === 'procedures_definition' || spec?.kind === 'H';
      const loose = !isHat && (!spec || spec.kind === 'S' || spec.kind === 'C' || spec.kind === 'P' || b.opcode === 'data_setvariableto' || b.opcode === 'data_changevariableby' || b.opcode === 'procedures_call');
      if (!isHat && !loose) throw new Unsupported(b.opcode);
      items.push({ script: { nodes: reader.chain(id), x, y, id } });
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      const ops = new Set<string>();
      const walk = (at: string | null | undefined): void => {
        while (at && blocks[at]) {
          const bb = blocks[at];
          if (!BY_OP.has(bb.opcode) && !/^(data_|argument_|procedures_)/.test(bb.opcode)) ops.add(bb.opcode);
          for (const inp of Object.values(bb.inputs ?? {})) {
            if (inp.block) walk(inp.block);
          }
          at = bb.next;
        }
      };
      walk(id);
      items.push({ kept: { id, label: [...ops].slice(0, 3).join(', ') || b.opcode, x, y } });
    }
  }
  return items;
}

/** Custom blocks defined in these blocks (so calls in other scripts can be understood even when a definition is kept). */
export function readProcs(blocks: Record<string, VmBlock>): { proccode: string; argIds: string[]; argNames: string[]; warp: boolean }[] {
  const out: { proccode: string; argIds: string[]; argNames: string[]; warp: boolean }[] = [];
  for (const b of Object.values(blocks)) {
    if (b.opcode !== 'procedures_prototype' || !b.mutation) continue;
    out.push({
      proccode: String(b.mutation.proccode ?? ''),
      argIds: parseList(b.mutation.argumentids),
      argNames: parseList(b.mutation.argumentnames),
      warp: truthy(b.mutation.warp),
    });
  }
  return out;
}
