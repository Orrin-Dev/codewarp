import { BY_OP, type ArgSpec } from './spec';
import { type Input, type Node, type Script, procArgTypes } from './tree';

/** What turning text into blocks needs from the project: the ids of variables and custom block arguments. */
export interface XmlContext {
  /** Id of the variable, list or broadcast message with this name (making it when it does not exist yet). */
  varId(name: string, type: 'var' | 'list' | 'broadcast'): string;
  /** Ids of the arguments of the custom block with this label (reuse the project's, or invent steady ones). */
  procArgIds(proccode: string, count: number): string[];
}

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const shadowXml = (type: string, field: string, value: string): string => `<shadow type="${type}"><field name="${field}">${esc(value)}</field></shadow>`;

class Emitter {
  constructor(private readonly ctx: XmlContext) {}

  private variableField(name: string, field: string, kind: 'var' | 'list' | 'broadcast', value: string): string {
    const type = kind === 'list' ? 'list' : kind === 'broadcast' ? 'broadcast_msg' : '';
    return `<field name="${field}" id="${esc(this.ctx.varId(value, kind))}" variabletype="${type}">${esc(value)}</field>`.replace(`name="${field}"`, `name="${name}"`);
  }

  private blockInput(input: Input & { node: Node }): string {
    return this.block(input.node, '');
  }

  private inputXml(name: string, input: Input | undefined, arg: ArgSpec): string {
    switch (arg.kind) {
      case 'b':
        return input && 'node' in input ? `<value name="${name}">${this.blockInput(input)}</value>` : '';
      case 'bcast': {
        const shadow = (v: string): string => `<shadow type="event_broadcast_menu">${this.variableField('BROADCAST_OPTION', 'BROADCAST_OPTION', 'broadcast', v)}</shadow>`;
        if (!input) return `<value name="${name}">${shadow('message1')}</value>`;
        if ('lit' in input) return `<value name="${name}">${shadow(input.lit)}</value>`;
        return `<value name="${name}">${shadow('message1')}${this.blockInput(input)}</value>`;
      }
      default: {
        const shadow = (v: string): string => shadowXml(arg.shadow!, arg.shadowField!, v);
        if (!input) return `<value name="${name}">${shadow('')}</value>`;
        if ('lit' in input) return `<value name="${name}">${shadow(input.lit)}</value>`;
        return `<value name="${name}">${shadow('')}${this.blockInput(input)}</value>`;
      }
    }
  }

  chain(nodes: Node[]): string {
    let next = '';
    for (let i = nodes.length - 1; i >= 0; i--) next = this.block(nodes[i], next);
    return next;
  }

  block(n: Node, next: string, pos = ''): string {
    const tail = next ? `<next>${next}</next>` : '';
    const open = `<block type="${n.op}"${pos}>`;
    const spec = BY_OP.get(n.op);
    if (spec) {
      let body = '';
      if (n.op === 'control_stop') body += `<mutation hasnext="${n.fields.STOP_OPTION === 'other scripts in sprite'}"></mutation>`;
      for (const a of spec.args) {
        if (a.kind === 'field') body += `<field name="${a.name}">${esc(n.fields[a.name] ?? '')}</field>`;
        else if (a.kind === 'bfield') body += this.variableField(a.name, a.name, 'broadcast', n.fields[a.name] ?? '');
        else if (a.kind === 'var') body += this.variableField(a.name, a.name, 'var', n.fields[a.name] ?? '');
        else if (a.kind === 'list') body += this.variableField(a.name, a.name, 'list', n.fields[a.name] ?? '');
        else if (a.kind === 'stack') {
          const inner = this.chain(n.stacks[a.name] ?? []);
          // The "else" part of an if/else is still drawn when it is empty.
          if (inner || (n.op === 'control_if_else' && a.name === 'SUBSTACK2') ) body += `<statement name="${a.name}">${inner}</statement>`;
        } else body += this.inputXml(a.name, n.inputs[a.name], a);
      }
      return `${open}${body}${tail}</block>`;
    }
    switch (n.op) {
      case 'data_setvariableto':
        return `${open}${this.variableField('VARIABLE', 'VARIABLE', 'var', n.fields.VARIABLE ?? '')}${this.inputXml('VALUE', n.inputs.VALUE, { name: 'VALUE', kind: 's', shadow: 'text', shadowField: 'TEXT' })}${tail}</block>`;
      case 'data_changevariableby':
        return `${open}${this.variableField('VARIABLE', 'VARIABLE', 'var', n.fields.VARIABLE ?? '')}${this.inputXml('VALUE', n.inputs.VALUE, { name: 'VALUE', kind: 'n', shadow: 'math_number', shadowField: 'NUM' })}${tail}</block>`;
      case 'data_variable':
        return `${open}${this.variableField('VARIABLE', 'VARIABLE', 'var', n.fields.VARIABLE ?? '')}${tail}</block>`;
      case 'data_listcontents':
        return `${open}${this.variableField('LIST', 'LIST', 'list', n.fields.LIST ?? '')}${tail}</block>`;
      case 'argument_reporter_string_number':
      case 'argument_reporter_boolean':
        return `${open}<field name="VALUE">${esc(n.fields.VALUE ?? '')}</field>${tail}</block>`;
      case 'procedures_call': {
        const proc = n.proc!;
        const types = procArgTypes(proc.proccode);
        const ids = this.ctx.procArgIds(proc.proccode, types.length);
        const mutation = `<mutation proccode="${esc(proc.proccode)}" argumentids="${esc(JSON.stringify(ids))}" warp="${proc.warp}"></mutation>`;
        const values = types
          .map((t, i) => {
            const input = n.inputs[String(i)];
            return this.inputXml(ids[i], input, t === 'b' ? { name: ids[i], kind: 'b' } : { name: ids[i], kind: 's', shadow: 'text', shadowField: 'TEXT' });
          })
          .join('');
        return `${open}${mutation}${values}${tail}</block>`;
      }
    }
    throw new Error(`Cannot write ${n.op} as blocks`);
  }

  definition(n: Node, rest: Node[], pos: string): string {
    const proc = n.proc!;
    const types = procArgTypes(proc.proccode);
    const ids = this.ctx.procArgIds(proc.proccode, types.length);
    const defaults = types.map((t) => (t === 'b' ? 'false' : ''));
    const mutation = `<mutation proccode="${esc(proc.proccode)}" argumentids="${esc(JSON.stringify(ids))}" argumentnames="${esc(JSON.stringify(proc.argNames))}" argumentdefaults="${esc(JSON.stringify(defaults))}" warp="${proc.warp}"></mutation>`;
    const reporters = types
      .map((t, i) => `<value name="${esc(ids[i])}"><shadow type="${t === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number'}"><field name="VALUE">${esc(proc.argNames[i] ?? '')}</field></shadow></value>`)
      .join('');
    const next = this.chain(rest);
    return `<block type="procedures_definition"${pos}><statement name="custom_block"><shadow type="procedures_prototype">${mutation}${reporters}</shadow></statement>${next ? `<next>${next}</next>` : ''}</block>`;
  }

  script(s: Script, x: number, y: number): string {
    const pos = ` x="${Math.round(x)}" y="${Math.round(y)}"`;
    const [head, ...rest] = s.nodes;
    if (head.op === 'procedures_definition') return this.definition(head, rest, pos);
    return this.block(head, this.chain(rest), pos);
  }
}

/** One script as Blockly XML (wrap several in <xml>...</xml> to load them together). */
export function scriptToXml(script: Script, ctx: XmlContext, x: number, y: number): string {
  if (script.nodes.length === 0) return '';
  return new Emitter(ctx).script(script, x, y);
}
