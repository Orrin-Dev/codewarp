import { BY_OP, INFIX, KEYWORDS, NOT_PREC, type ArgSpec, type BlockSpec, type Skin, procBaseName, skinName } from './spec';
import { type Input, type Node, type Script, type VarDecl, procArgTypes } from './tree';

/** One top-level thing in the text: a script, or a script the text syntax cannot express yet. */
export type Item = { script: Script } | { kept: { id: string; label: string; x: number; y: number } };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export const quote = (s: string): string =>
  `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

/** A variable, list or argument name: plain when it can be, `in backticks` otherwise. */
export function ident(name: string): string {
  if (IDENT.test(name) && !KEYWORDS.has(name)) return name;
  return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

/** What a custom block called `printed` would be labelled in Scratch if nothing else is said. */
export function defaultProccode(printed: string, skin: Skin, argTypes: ('s' | 'b')[]): string {
  const words =
    skin === 'python'
      ? printed.split('_')
      : printed.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ');
  return [words.join(' ').toLowerCase(), ...argTypes.map((t) => `%${t}`)].join(' ');
}

const TAKEN = new Map<Skin, Set<string>>();
function takenNames(skin: Skin): Set<string> {
  let set = TAKEN.get(skin);
  if (!set) {
    set = new Set([...BY_OP.values()].map((b) => skinName(b.name, skin)));
    TAKEN.set(skin, set);
  }
  return set;
}

/** The name a custom block is written with. A trailing _ keeps it from clashing with a built-in block or keyword. */
export function procPrintedName(proccode: string, skin: Skin): string {
  const name = skinName(procBaseName(proccode), skin);
  return takenNames(skin).has(name) || KEYWORDS.has(name) ? `${name}_` : name;
}

class Printer {
  private lines: string[] = [];
  constructor(private readonly skin: Skin) {}

  private get cs(): boolean {
    return this.skin === 'csharp';
  }

  out(): string {
    return this.lines.join('\n');
  }

  line(depth: number, text: string): void {
    this.lines.push(text === '' ? '' : '    '.repeat(depth) + text);
  }

  // ---- expressions ----

  literal(value: string, arg: ArgSpec | undefined): string {
    const kind = arg?.kind;
    if (kind === 'n' || kind === 's' || kind === undefined) return NUMBER.test(value) ? value : quote(value);
    return quote(value);
  }

  input(input: Input | undefined, arg: ArgSpec | undefined, prec = 0): string {
    if (!input) return this.cs ? 'default' : 'None';
    if ('lit' in input) return this.literal(input.lit, arg);
    return this.expr(input.node, prec);
  }

  private fn(spec: BlockSpec | undefined, fallback: string): string {
    return skinName(spec?.name ?? fallback, this.skin);
  }

  callText(n: Node, spec: BlockSpec): string {
    const recv = spec.args.find((a) => a.receiver);
    const rest = spec.args.filter((a) => !a.receiver);
    const args = rest.map((a) => this.argText(n, a)).join(', ');
    const name = this.fn(spec, spec.name);
    return recv ? `${ident(n.fields[recv.name] ?? '')}.${name}(${args})` : `${name}(${args})`;
  }

  private argText(n: Node, a: ArgSpec): string {
    if (a.kind === 'field' || a.kind === 'bfield') return quote(n.fields[a.name] ?? '');
    if (a.kind === 'var' || a.kind === 'list') return ident(n.fields[a.name] ?? '');
    return this.input(n.inputs[a.name], a);
  }

  expr(n: Node, prec = 0): string {
    const info = INFIX[n.op];
    if (info) {
      const spec = BY_OP.get(n.op)!;
      const sym = this.cs ? info.csharp : info.python;
      const left = this.input(n.inputs[spec.args[0].name], spec.args[0], info.prec);
      const right = this.input(n.inputs[spec.args[1].name], spec.args[1], info.prec + 1);
      const text = `${left} ${sym} ${right}`;
      return info.prec < prec ? `(${text})` : text;
    }
    switch (n.op) {
      case 'operator_not': {
        const inner = n.inputs.OPERAND;
        const wrap = inner && 'node' in inner && INFIX[inner.node.op];
        const body = this.input(inner, undefined);
        return `${this.cs ? '!' : 'not '}${wrap ? `(${body})` : body}`;
      }
      case 'data_variable':
      case 'data_listcontents':
        return ident(n.fields.VARIABLE ?? n.fields.LIST ?? '');
      case 'argument_reporter_string_number':
      case 'argument_reporter_boolean':
        return ident(n.fields.VALUE ?? '');
      case 'procedures_call':
        return this.procCall(n);
    }
    const spec = BY_OP.get(n.op);
    if (!spec) return this.cs ? 'default' : 'None';
    return this.callText(n, spec);
  }

  procCall(n: Node): string {
    const proc = n.proc!;
    const types = procArgTypes(proc.proccode);
    const args = types.map((_, i) => this.input(n.inputs[String(i)], { name: String(i), kind: types[i] === 'b' ? 'b' : 's' })).join(', ');
    return `${procPrintedName(proc.proccode, this.skin)}(${args})`;
  }

  // ---- statements ----

  private block(depth: number, head: string, body: Node[]): void {
    if (this.cs) {
      this.line(depth, `${head} {`);
      this.statements(depth + 1, body);
      this.line(depth, '}');
    } else {
      this.line(depth, `${head}:`);
      if (body.length === 0) this.line(depth + 1, 'pass');
      else this.statements(depth + 1, body);
    }
  }

  statements(depth: number, nodes: Node[]): void {
    for (const n of nodes) this.statement(depth, n);
  }

  private end(text: string): string {
    return this.cs ? `${text};` : text;
  }

  statement(depth: number, n: Node): void {
    switch (n.op) {
      case 'data_setvariableto':
        this.line(depth, this.end(`${ident(n.fields.VARIABLE ?? '')} = ${this.input(n.inputs.VALUE, { name: 'VALUE', kind: 's' })}`));
        return;
      case 'data_changevariableby':
        this.line(depth, this.end(`${ident(n.fields.VARIABLE ?? '')} += ${this.input(n.inputs.VALUE, { name: 'VALUE', kind: 'n' })}`));
        return;
      case 'procedures_call':
        this.line(depth, this.end(this.procCall(n)));
        return;
      case 'control_repeat':
        this.block(depth, `repeat ${this.cs ? `(${this.input(n.inputs.TIMES, BY_OP.get(n.op)!.args[0])})` : this.input(n.inputs.TIMES, BY_OP.get(n.op)!.args[0])}`, n.stacks.SUBSTACK ?? []);
        return;
      case 'control_forever':
        this.block(depth, 'forever', n.stacks.SUBSTACK ?? []);
        return;
      case 'control_repeat_until':
        this.block(depth, `until ${this.cs ? `(${this.input(n.inputs.CONDITION, undefined)})` : this.input(n.inputs.CONDITION, undefined)}`, n.stacks.SUBSTACK ?? []);
        return;
      case 'control_if':
      case 'control_if_else':
        this.ifChain(depth, n, true);
        return;
    }
    const spec = BY_OP.get(n.op);
    if (!spec) return;
    this.line(depth, this.end(this.callText(n, spec)));
  }

  private body(depth: number, nodes: Node[]): void {
    if (!this.cs && nodes.length === 0) this.line(depth, 'pass');
    else this.statements(depth, nodes);
  }

  /** if / else if / else, written as a chain when the else only holds another if. */
  private ifChain(depth: number, n: Node, first: boolean): void {
    const cond = this.input(n.inputs.CONDITION, undefined);
    if (this.cs) this.line(depth, first ? `if (${cond}) {` : `} else if (${cond}) {`);
    else this.line(depth, first ? `if ${cond}:` : `elif ${cond}:`);
    this.body(depth + 1, n.stacks.SUBSTACK ?? []);
    if (n.op === 'control_if_else') {
      const other = n.stacks.SUBSTACK2 ?? [];
      if (other.length === 1 && (other[0].op === 'control_if' || other[0].op === 'control_if_else')) {
        this.ifChain(depth, other[0], false);
        return;
      }
      this.line(depth, this.cs ? '} else {' : 'else:');
      this.body(depth + 1, other);
    }
    if (this.cs) this.line(depth, '}');
  }

  // ---- scripts ----

  script(s: Script): void {
    const [head, ...rest] = s.nodes;
    if (!head) return;
    if (head.op === 'procedures_definition') {
      this.define(head, rest);
      return;
    }
    const spec = BY_OP.get(head.op);
    if (spec?.kind === 'H') {
      const args = spec.args.map((a) => this.argText(head, a)).join(', ');
      const name = this.fn(spec, spec.name);
      const call = spec.args.length > 0 ? `${name}(${args})` : name;
      this.block(0, `when ${call}`, rest);
      return;
    }
    // A loose stack with no hat: written as a block with no event.
    this.block(0, 'loose', s.nodes);
  }

  private define(head: Node, body: Node[]): void {
    const proc = head.proc!;
    const types = procArgTypes(proc.proccode);
    const name = procPrintedName(proc.proccode, this.skin);
    const params = proc.argNames.map((a, i) => {
      const t = types[i] ?? 's';
      return this.cs ? `${t === 'b' ? 'bool' : 'string'} ${ident(a)}` : `${ident(a)}${t === 'b' ? ': bool' : ''}`;
    });
    if (proc.warp) this.line(0, this.cs ? '[Warp]' : '@warp');
    if (defaultProccode(name, this.skin, types) !== proc.proccode) this.line(0, this.cs ? `[Block(${quote(proc.proccode)})]` : `@block(${quote(proc.proccode)})`);
    this.block(0, this.cs ? `void ${name}(${params.join(', ')})` : `def ${name}(${params.join(', ')})`, body);
  }
}

export function printScript(script: Script, skin: Skin): string {
  const p = new Printer(skin);
  p.script(script);
  return p.out();
}

export function printDecl(d: VarDecl, skin: Skin): string {
  const words = [d.cloud ? 'cloud' : '', d.local ? 'local' : '', d.type === 'list' ? 'list' : 'var', ident(d.name)].filter(Boolean).join(' ');
  return skin === 'csharp' ? `${words};` : words;
}

/** The whole text for one sprite: variable declarations, then every script. */
export function printItems(items: Item[], decls: VarDecl[], skin: Skin): string {
  const chunks: string[] = [];
  if (decls.length > 0) chunks.push(decls.map((d) => printDecl(d, skin)).join('\n'));
  for (const item of items) {
    if ('script' in item) chunks.push(printScript(item.script, skin));
    else chunks.push(`${skin === 'csharp' ? '//' : '#'} kept: ${item.kept.id} (${item.kept.label})`);
  }
  return chunks.join('\n\n') + '\n';
}
