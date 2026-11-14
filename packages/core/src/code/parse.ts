import { BLOCKS, BY_OP, INFIX_BY_SYMBOL, NOT_PREC, type BlockSpec, type Skin, methodName, methodSpellings, skinName } from './spec';
import { SyntaxFail, lex, type Token } from './lex';
import { defaultProccode, procPrintedName } from './print';
import { closest } from './suggest';
import { type Input, type Node, type Proc, type Script, type VarDecl, node, procArgTypes } from './tree';

export interface ParseError {
  message: string;
  line: number;
  col: number;
  len: number;
}

export interface ParseResult {
  scripts: Script[];
  decls: VarDecl[];
  /** Ids of scripts that stay as they are (named in "kept:" comments). */
  kept: Set<string>;
  errors: ParseError[];
}

export interface ParseOptions {
  skin: Skin;
  /** Custom blocks defined elsewhere (kept scripts), so calls to them can be understood. */
  externalProcs?: Proc[];
}

type Value = Input | null;

const BOOLEAN_OPS = new Set(['operator_not', 'operator_and', 'operator_or', 'operator_gt', 'operator_lt', 'operator_equals', 'argument_reporter_boolean']);
const isBoolean = (n: Node): boolean => BOOLEAN_OPS.has(n.op) || BY_OP.get(n.op)?.kind === 'B';

interface Tables {
  fn: Map<string, BlockSpec>;
  methods: Map<string, BlockSpec>;
  hats: Map<string, BlockSpec>;
}

function tables(): Tables {
  const t: Tables = { fn: new Map(), methods: new Map(), hats: new Map() };
  const add = (map: Map<string, BlockSpec>, spec: BlockSpec): void => {
    for (const skin of ['csharp', 'python'] as Skin[]) map.set(skinName(spec.name, skin), spec);
  };
  for (const spec of BLOCKS) {
    if (spec.kind === 'H') add(t.hats, spec);
    else if (spec.kind === 'C') continue;
    else if (spec.args.some((a) => a.receiver)) for (const spelling of methodSpellings(spec)) t.methods.set(spelling, spec);
    else add(t.fn, spec);
  }
  return t;
}
const TABLES = tables();

class Parser {
  private p = 0;
  private readonly errors: ParseError[] = [];
  private readonly decls = new Map<string, VarDecl>();
  private readonly defs = new Map<string, Proc>();
  private readonly pending: { node: Node; name: string; argc: number; tok: Token }[] = [];
  private params: Map<string, 's' | 'b'> | null = null;
  private readonly scripts: Script[] = [];
  private readonly py: boolean;

  constructor(
    private readonly t: Token[],
    private readonly kept: Set<string>,
    private readonly opts: ParseOptions,
  ) {
    this.py = opts.skin === 'python';
  }

  private declHint(name: string, type: 'var' | 'list'): string {
    const quoted = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `\`${name}\``;
    if (this.py) return `${quoted}: ${type === 'list' ? 'List' : 'Variable'}`;
    return `public ${type === 'list' ? 'List<var>' : 'var'} ${quoted};`;
  }

  // ---- token helpers ----

  private get tok(): Token {
    return this.t[this.p];
  }
  private peekAt(n: number): Token {
    return this.t[Math.min(this.p + n, this.t.length - 1)];
  }
  private next(): Token {
    const tok = this.t[this.p];
    if (tok.type !== 'eof') this.p++;
    return tok;
  }
  private isSym(s: string, at = 0): boolean {
    const tok = this.peekAt(at);
    return tok.type === 'sym' && tok.text === s;
  }
  private isWord(w: string, at = 0): boolean {
    const tok = this.peekAt(at);
    return tok.type === 'ident' && !tok.quoted && tok.text === w;
  }
  private fail(message: string, tok: Token = this.tok): never {
    throw new SyntaxFail(message, tok.line, tok.col, tok.len);
  }
  private failAfterPrevious(message: string): never {
    const prev = this.t[Math.max(0, this.p - 1)];
    throw new SyntaxFail(message, prev.line, prev.col + prev.len, 1);
  }
  private expectSym(s: string, what = `"${s}"`): Token {
    if (!this.isSym(s)) this.fail(`Expected ${what} here`);
    return this.next();
  }
  private describe(tok: Token): string {
    return tok.type === 'eof' ? 'the end' : tok.type === 'newline' ? 'the end of the line' : tok.type === 'dedent' || tok.type === 'indent' ? 'the indentation' : `"${tok.text}"`;
  }

  // ---- program ----

  run(): ParseResult {
    this.prescan();
    while (this.tok.type !== 'eof') {
      if (this.tok.type === 'newline' || this.tok.type === 'dedent' || this.tok.type === 'indent') {
        this.next();
        continue;
      }
      const startLine = this.tok.line;
      try {
        this.topLevel();
      } catch (error) {
        if (!(error instanceof SyntaxFail)) throw error;
        this.errors.push({ message: error.message, line: error.line, col: error.col, len: error.len });
        this.recover(startLine);
      }
    }
    this.resolveCalls();
    return { scripts: this.scripts, decls: [...this.decls.values()], kept: this.kept, errors: this.errors.sort((a, b) => a.line - b.line || a.col - b.col) };
  }

  /** Skip to the next thing that starts at the left edge, so one mistake does not hide the rest. */
  private recover(startLine: number): void {
    this.params = null;
    if (this.p > 0 && this.tok.line === startLine && this.tok.type !== 'eof') this.next();
    while (this.tok.type !== 'eof') {
      const tok = this.tok;
      const starts = tok.col === 1 && tok.line > startLine && (tok.type === 'ident' || (tok.type === 'sym' && (tok.text === '[' || tok.text === '@')));
      if (starts) return;
      this.next();
    }
  }

  /**
   * A variable or list declaration starting at token i, or null. Written
   *   C#:      [Cloud] public var score;   private var speed;   public List<var> items;
   *   Python:  score: Variable   speed: Local[Variable]   items: List   hi: Cloud[Variable]
   * (the older  var score  /  local list items  forms still work).
   */
  private scanDecl(i: number): { decl: VarDecl; end: number } | null {
    const t = this.t;
    const word = (k: number): string => (t[k] && t[k].type === 'ident' && !t[k].quoted ? t[k].text : '');
    const sym = (k: number, s: string): boolean => !!t[k] && t[k].type === 'sym' && t[k].text === s;
    // Python annotation
    if (t[i]?.type === 'ident' && sym(i + 1, ':')) {
      let k = i + 2;
      let w = word(k);
      let local = false;
      let cloud = false;
      if (w === 'Local' || w === 'Cloud') {
        if (!sym(k + 1, '[')) return null;
        local = w === 'Local';
        cloud = w === 'Cloud';
        k += 2;
        w = word(k);
        if (!sym(k + 1, ']')) return null;
        k += 1;
      }
      if (w !== 'Variable' && w !== 'List') return null;
      return { decl: { name: t[i].text, type: w === 'List' ? 'list' : 'var', local, cloud }, end: k + 1 };
    }
    let j = i;
    let cloud = false;
    let local = false;
    if (sym(j, '[') && word(j + 1).toLowerCase() === 'cloud' && sym(j + 2, ']')) {
      cloud = true;
      j += 3;
    }
    for (;;) {
      const w = word(j);
      if (w === 'cloud') cloud = true;
      else if (w === 'local' || w === 'private') local = true;
      else if (w === 'global' || w === 'public') local = false;
      else break;
      j++;
    }
    let type: 'var' | 'list' | null = null;
    const w = word(j);
    if (w === 'var') {
      type = 'var';
      j++;
    } else if (w === 'list') {
      type = 'list';
      j++;
    } else if (w === 'List' && sym(j + 1, '<') && (word(j + 2) === 'var' || word(j + 2) === 'object') && sym(j + 3, '>')) {
      type = 'list';
      j += 4;
    }
    if (!type || t[j]?.type !== 'ident' || sym(j + 1, '(')) return null;
    return { decl: { name: t[j].text, type, local, cloud }, end: j + 1 };
  }

  /** Variables first (a script can use one that is declared further down). */
  private prescan(): void {
    for (let i = 0; i < this.t.length; i++) {
      const tok = this.t[i];
      if (tok.col !== 1 || (tok.type !== 'ident' && tok.text !== '[')) continue;
      const found = this.scanDecl(i);
      if (found && !this.decls.has(found.decl.name)) this.decls.set(found.decl.name, found.decl);
    }
  }

  private topLevel(): void {
    const tok = this.tok;
    if (this.scanDecl(this.p)) return this.declaration();
    if (tok.type === 'ident' && !tok.quoted) {
      if (tok.text === 'when') return this.hat();
      if (tok.text === 'loose') {
        this.next();
        const body = this.block();
        this.scripts.push({ nodes: body, x: 0, y: 0 });
        return;
      }
      if ((!this.py && tok.text === 'void') || (this.py && tok.text === 'def')) return this.define(false, null, null, false);
    }
    if ((!this.py && this.isSym('[')) || (this.py && this.isSym('@'))) return this.attributes();
    this.fail(
      this.py
        ? 'Scripts start with an event like "@when_flag_clicked" above a "def", or a custom block "def name():". Put this inside one.'
        : 'Scripts start with an event like "[WhenFlagClicked]" above a "void", or a custom block "void Name() { }". Put this inside one.',
    );
  }

  private declaration(): void {
    const found = this.scanDecl(this.p);
    if (!found) this.fail('Expected a variable or list declaration here');
    this.p = found.end;
    this.endStatement();
  }

  private attributes(): void {
    let warp = false;
    let code: string | null = null;
    let noEvent = false;
    let hat: { spec: BlockSpec; args: Value[]; tok: Token } | null = null;
    for (;;) {
      const bracket = !this.py && this.isSym('[');
      const at = this.py && this.isSym('@');
      if (!bracket && !at) break;
      this.next();
      const name = this.tok;
      if (name.type !== 'ident') this.fail(this.py ? 'Expected a decorator name like @warp or @when_flag_clicked' : 'Expected an attribute name like [Warp] or [WhenFlagClicked]');
      this.next();
      const lower = name.text.toLowerCase().replace(/_/g, '');
      if (lower === 'warp') warp = true;
      else if (lower === 'block') code = this.attributeArg();
      else if (lower === 'noevent') noEvent = true;
      else if (lower.startsWith('when')) {
        const spec = TABLES.hats.get(name.text.replace(/^when_?/i, '')) ?? [...TABLES.hats.values()].find((h) => h.name.replace(/_/g, '') === lower.slice(4));
        if (!spec) this.fail(`"${name.text}" is not an event. Try ${this.py ? '@when_flag_clicked' : '[WhenFlagClicked]'}`, name);
        const args: Value[] = this.isSym('(') ? this.argList() : [];
        hat = { spec, args, tok: name };
      } else if (lower === 'cloud') this.fail(`Put ${this.py ? 'Cloud[Variable]' : '[Cloud]'} on a variable, not on a script`, name);
      else this.fail(this.py ? 'Unknown decorator. Use @warp, @block("label") or @when_...' : 'Unknown attribute. Use [Warp], [Block("label")] or [When...]', name);
      if (bracket) this.expectSym(']');
      else while ((this.tok.type as string) === 'newline') this.next();
    }
    if (!((!this.py && this.isWord('void')) || (this.py && this.isWord('def')))) this.fail('Attributes go right before a method');
    this.define(warp, code, hat, noEvent);
  }

  private attributeArg(): string {
    this.expectSym('(');
    if (this.tok.type !== 'str') this.fail('Expected the label in quotes');
    const label = this.next().text;
    this.expectSym(')');
    return label;
  }

  /** `void Name(args) { }` / `def name(args):`. With an event attribute it is that event's script instead of a custom block. */
  private define(warp: boolean, code: string | null, hat: { spec: BlockSpec; args: Value[]; tok: Token } | null, noEvent: boolean): void {
    this.next(); // void / def
    const nameTok = this.tok;
    if (nameTok.type !== 'ident') this.fail('Expected a name');
    this.next();
    this.expectSym('(');
    if (hat || noEvent) {
      if (!this.isSym(')')) this.fail('Event scripts take no arguments here. Put the event\'s values in the attribute, like [WhenKeyPressed("space")]');
      this.next();
      const body = this.block();
      if (hat) {
        const head = node(hat.spec.op);
        this.bind(head, hat.spec, hat.args, hat.tok);
        this.scripts.push({ nodes: [head, ...body], x: 0, y: 0 });
      } else this.scripts.push({ nodes: body, x: 0, y: 0 });
      return;
    }
    const names: string[] = [];
    const types: ('s' | 'b')[] = [];
    if (!this.isSym(')')) {
      for (;;) {
        let type: 's' | 'b' = 's';
        if (!this.py) {
          const typeTok = this.tok;
          if (typeTok.type !== 'ident') this.fail('Expected a type (string or bool) before the argument name');
          if (typeTok.text === 'bool') type = 'b';
          else if (!['string', 'number', 'int', 'float', 'double'].includes(typeTok.text)) this.fail('Argument types are string, number or bool', typeTok);
          this.next();
        }
        const argTok = this.tok;
        if (argTok.type !== 'ident') this.fail('Expected an argument name');
        this.next();
        if (this.py && this.isSym(':')) {
          this.next();
          const typeTok = this.tok;
          if (typeTok.type === 'ident' && typeTok.text === 'bool') type = 'b';
          else if (!(typeTok.type === 'ident' && ['str', 'string', 'number', 'int', 'float'].includes(typeTok.text))) this.fail('Argument types are str, number or bool', typeTok);
          this.next();
        }
        if (names.includes(argTok.text)) this.fail('Two arguments have the same name', argTok);
        names.push(argTok.text);
        types.push(type);
        if (this.isSym(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectSym(')');
    const proccode = code ?? defaultProccode(nameTok.text, this.opts.skin, types);
    if (code !== null && procArgTypes(code).join('') !== types.join('')) this.fail(`The label "${code}" has ${procArgTypes(code).length} slots but the block has ${types.length} arguments`, nameTok);
    const proc: Proc = { proccode, argNames: names, warp };
    if (this.defs.has(nameTok.text)) this.fail('A custom block with this name is already defined', nameTok);
    if (TABLES.fn.has(nameTok.text) || TABLES.hats.has(nameTok.text)) this.fail(`"${nameTok.text}" is a built-in block. Pick another name`, nameTok);
    this.defs.set(nameTok.text, proc);
    const params = new Map<string, 's' | 'b'>(names.map((n, i) => [n, types[i]]));
    const outer = this.params;
    this.params = params;
    const body = this.block();
    this.params = outer;
    const head = node('procedures_definition');
    head.proc = proc;
    this.scripts.push({ nodes: [head, ...body], x: 0, y: 0 });
  }

  private hat(): void {
    this.next(); // when
    const nameTok = this.tok;
    if (nameTok.type !== 'ident') this.fail('Expected an event after "when", like FlagClicked');
    const spec = TABLES.hats.get(nameTok.text);
    if (!spec) this.fail(`"${nameTok.text}" is not an event. Try ${skinName('flag_clicked', this.opts.skin)}`);
    this.next();
    const head = node(spec.op);
    let args: Value[] = [];
    if (this.isSym('(')) args = this.argList();
    this.bind(head, spec, args, nameTok);
    const body = this.block();
    this.scripts.push({ nodes: [head, ...body], x: 0, y: 0 });
  }

  // ---- blocks and statements ----

  /** `{ ... }` in C#, `: newline indent ... dedent` in Python. */
  private block(): Node[] {
    const nodes: Node[] = [];
    if (this.py) {
      this.expectSym(':', '":" after this line');
      if (this.tok.type !== 'newline') this.fail('Put the lines that go inside on the next line, indented');
      this.next();
      if ((this.tok.type as string) !== 'indent') this.fail('Expected indented lines here (use "pass" for nothing)');
      this.next();
      while ((this.tok.type as string) !== 'dedent' && (this.tok.type as string) !== 'eof') {
        if ((this.tok.type as string) === 'newline') {
          this.next();
          continue;
        }
        if (this.isWord('pass')) {
          this.next();
          this.endStatement();
          continue;
        }
        nodes.push(this.statement());
      }
      if ((this.tok.type as string) === 'dedent') this.next();
      return nodes;
    }
    this.expectSym('{');
    while (!this.isSym('}')) {
      if (this.tok.type === 'eof') this.fail('Missing "}" at the end of this block', this.t[Math.max(0, this.p - 1)]);
      nodes.push(this.statement());
    }
    this.next();
    return nodes;
  }

  private endStatement(): void {
    if (this.py) {
      if (this.tok.type === 'newline') this.next();
      else if (this.tok.type !== 'dedent' && this.tok.type !== 'eof') this.fail(`Unexpected ${this.describe(this.tok)}. Each line holds one statement`);
      return;
    }
    if (this.isSym(';')) {
      this.next();
      return;
    }
    this.failAfterPrevious('Missing ";" at the end of this line');
  }

  private condition(): Input | undefined {
    let value: Value;
    if (this.py) value = this.expression();
    else {
      this.expectSym('(');
      value = this.expression();
      this.expectSym(')');
    }
    if (value && 'lit' in value) this.fail('This needs a true/false condition, not a typed-in value', this.t[this.p - 1]);
    if (value && !isBoolean(value.node)) this.fail('This needs a true/false condition. Try a comparison like x > 5', this.t[this.p - 1]);
    return value ?? undefined;
  }

  private statement(): Node {
    const tok = this.tok;
    if (tok.type === 'ident' && !tok.quoted) {
      switch (tok.text) {
        case 'if':
          return this.ifStatement();
        case 'repeat': {
          this.next();
          let times: Value;
          if (this.py) times = this.expression();
          else {
            this.expectSym('(');
            times = this.expression();
            this.expectSym(')');
          }
          const n = node('control_repeat');
          if (times) n.inputs.TIMES = times;
          n.stacks.SUBSTACK = this.block();
          return n;
        }
        case 'forever': {
          this.next();
          const n = node('control_forever');
          n.stacks.SUBSTACK = this.block();
          return n;
        }
        case 'until': {
          this.next();
          const n = node('control_repeat_until');
          const cond = this.condition();
          if (cond) n.inputs.CONDITION = cond;
          n.stacks.SUBSTACK = this.block();
          return n;
        }
        case 'for': {
          this.next();
          const n = node('control_repeat');
          let times: Value;
          if (this.py) {
            if (this.tok.type !== 'ident') this.fail('Expected a name after "for", like: for _ in range(10):');
            this.next();
            if (!this.isWord('in')) this.fail('Expected "in range(...)" here, like: for _ in range(10):');
            this.next();
            if (!this.isWord('range')) this.fail('Scratch can only repeat a number of times: for _ in range(10):');
            this.next();
            this.expectSym('(');
            times = this.expression();
            this.expectSym(')');
          } else {
            this.expectSym('(');
            if (!this.isWord('int') && !this.isWord('var')) this.fail('Scratch can only repeat a number of times: for (int i = 0; i < 10; i++)');
            this.next();
            const counter = this.tok;
            if (counter.type !== 'ident') this.fail('Expected a counter name, like: for (int i = 0; i < 10; i++)');
            this.next();
            this.expectSym('=');
            const zero = this.tok;
            if (zero.type !== 'num' || Number(zero.text) !== 0) this.fail('The counter has to start at 0: for (int i = 0; i < 10; i++)');
            this.next();
            this.expectSym(';');
            if (!(this.tok.type === 'ident' && this.tok.text === counter.text)) this.fail(`Expected "${counter.text} < ..." here`);
            this.next();
            this.expectSym('<');
            times = this.expression();
            this.expectSym(';');
            if (!(this.tok.type === 'ident' && this.tok.text === counter.text)) this.fail(`Expected "${counter.text}++" here`);
            this.next();
            this.expectSym('++');
            this.expectSym(')');
          }
          if (times) n.inputs.TIMES = times;
          n.stacks.SUBSTACK = this.block();
          return n;
        }
        case 'while': {
          this.next();
          // while (true) / while True: is "forever"
          const trueWord = this.py ? 'True' : 'true';
          if ((this.isWord(trueWord) && (this.isSym(this.py ? ':' : ')', 1))) || (!this.py && this.isSym('(') && this.isWord('true', 1) && this.isSym(')', 2))) {
            if (!this.py && this.isSym('(')) this.next();
            this.next();
            if (!this.py) this.expectSym(')');
            const n = node('control_forever');
            n.stacks.SUBSTACK = this.block();
            return n;
          }
          const cond = this.condition();
          const n = node('control_repeat_until');
          // "while (x < 5)" runs until x < 5 is no longer true; "while (!done)" runs until done.
          if (cond && 'node' in cond && cond.node.op === 'operator_not') {
            const inner = cond.node.inputs.OPERAND;
            if (inner) n.inputs.CONDITION = inner;
          } else if (cond) {
            const flip = node('operator_not');
            flip.inputs.OPERAND = cond;
            n.inputs.CONDITION = { node: flip };
          }
          n.stacks.SUBSTACK = this.block();
          return n;
        }
        case 'else':
        case 'elif':
          this.fail('"else" has to come right after the closing of an "if"');
      }
    }
    // variable assignment
    if (tok.type === 'ident' && (this.isSym('=', 1) || this.isSym('+=', 1) || this.isSym('-=', 1))) {
      const decl = this.decls.get(tok.text);
      if (this.params?.has(tok.text)) this.fail('Arguments cannot be changed', tok);
      if (!decl) this.fail(`Unknown variable "${tok.text}". Declare it first with ${this.declHint(tok.text, 'var')}`, tok);
      if (decl.type !== 'var') this.fail(`"${tok.text}" is a list. Use ${tok.text}.${methodName(BLOCKS.find((b) => b.op === 'data_addtolist')!, this.opts.skin)}(...) to change it`, tok);
      this.next();
      const opTok = this.next();
      const value = this.expression();
      if (!value) this.fail('Give a value to put in the variable', opTok);
      this.endStatement();
      if (opTok.text === '=') {
        const n = node('data_setvariableto');
        n.fields.VARIABLE = tok.text;
        n.inputs.VALUE = value;
        return n;
      }
      const n = node('data_changevariableby');
      n.fields.VARIABLE = tok.text;
      if (opTok.text === '+=') n.inputs.VALUE = value;
      else if ('lit' in value && /^\d+(\.\d+)?$/.test(value.lit)) n.inputs.VALUE = { lit: `-${value.lit}` };
      else {
        const sub = node('operator_subtract');
        sub.inputs.NUM1 = { lit: '0' };
        sub.inputs.NUM2 = value;
        n.inputs.VALUE = { node: sub };
      }
      return n;
    }
    // call
    const start = this.tok;
    const value = this.expression();
    if (!value || 'lit' in value) this.fail('This is not a statement. Statements are things like Move(10); or score = 0;', start);
    const n = value.node;
    const spec = BY_OP.get(n.op);
    const isStatement = n.op === 'procedures_call' || (spec && (spec.kind === 'S' || spec.kind === 'P'));
    if (!isStatement) this.fail('This gives a value, so it can only be used inside another block', start);
    this.endStatement();
    return n;
  }

  private ifStatement(): Node {
    this.next(); // if / elif
    const cond = this.condition();
    const body = this.block();
    const n = node('control_if');
    if (cond) n.inputs.CONDITION = cond;
    n.stacks.SUBSTACK = body;
    if (this.isWord('elif')) {
      n.op = 'control_if_else';
      n.stacks.SUBSTACK2 = [this.ifStatement()];
    } else if (this.isWord('else')) {
      this.next();
      n.op = 'control_if_else';
      if (this.isWord('if')) n.stacks.SUBSTACK2 = [this.ifStatement()];
      else n.stacks.SUBSTACK2 = this.block();
    }
    return n;
  }

  // ---- expressions ----

  private argList(): Value[] {
    this.expectSym('(');
    const args: Value[] = [];
    if (!this.isSym(')')) {
      for (;;) {
        args.push(this.expression());
        if (this.isSym(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    if (!this.isSym(')')) this.fail(`Expected "," or ")" here, found ${this.describe(this.tok)}`);
    this.next();
    return args;
  }

  private binaryOp(): { op: string; prec: number; tok: Token } | null {
    const tok = this.tok;
    let sym = '';
    if (tok.type === 'sym') sym = tok.text;
    else if (tok.type === 'ident' && !tok.quoted && (tok.text === 'and' || tok.text === 'or')) sym = tok.text;
    if (!sym) return null;
    if (sym === '!=' || sym === '<=' || sym === '>=') return { op: sym, prec: 4, tok };
    const op = INFIX_BY_SYMBOL.get(sym);
    if (!op) return null;
    const prec = { operator_or: 1, operator_and: 2, operator_equals: 4, operator_gt: 4, operator_lt: 4, operator_add: 5, operator_subtract: 5, operator_multiply: 6, operator_divide: 6, operator_mod: 6 }[op] ?? 0;
    return { op, prec, tok };
  }

  private make(op: string, a: Input, b: Input, tok: Token): Input {
    const spec = BY_OP.get(op)!;
    const n = node(op);
    n.inputs[spec.args[0].name] = a;
    n.inputs[spec.args[1].name] = b;
    this.checkSlot(spec.args[0].kind, a, tok);
    this.checkSlot(spec.args[1].kind, b, tok);
    return { node: n };
  }

  private checkSlot(kind: string, value: Input, tok: Token): void {
    if (kind === 'b' && ('lit' in value || !isBoolean(value.node))) this.fail('This needs a true/false value, like a comparison', tok);
  }

  expression(minPrec = 0): Value {
    let left = this.unary();
    for (;;) {
      const op = this.binaryOp();
      if (!op || op.prec < minPrec || op.prec === 0) break;
      this.next();
      const right = this.expression(op.prec + 1);
      if (!left || !right) this.fail('There is nothing to calculate with here', op.tok);
      if (op.op === '!=' || op.op === '<=' || op.op === '>=') {
        const base = op.op === '!=' ? 'operator_equals' : op.op === '<=' ? 'operator_gt' : 'operator_lt';
        const inner = this.make(base, left, right, op.tok);
        const wrap = node('operator_not');
        wrap.inputs.OPERAND = inner;
        left = { node: wrap };
      } else left = this.make(op.op, left, right, op.tok);
    }
    return left;
  }

  private unary(): Value {
    const tok = this.tok;
    if (tok.type === 'sym' && tok.text === '!') {
      this.next();
      return this.notOf(this.expression(NOT_PREC + 1), tok);
    }
    if (tok.type === 'ident' && !tok.quoted && tok.text === 'not') {
      this.next();
      return this.notOf(this.expression(NOT_PREC + 1), tok);
    }
    if (tok.type === 'sym' && tok.text === '-') {
      this.next();
      const operand = this.tok;
      if (operand.type === 'num') {
        this.next();
        return { lit: `-${operand.text}` };
      }
      const inner = this.unary();
      if (!inner) this.fail('Nothing to negate here', tok);
      return this.make('operator_subtract', { lit: '0' }, inner, tok);
    }
    return this.postfix();
  }

  private notOf(value: Value, tok: Token): Input {
    if (value && 'lit' in value) this.fail('"not" needs a true/false value', tok);
    if (value && !isBoolean(value.node)) this.fail('"not" needs a true/false value, like a comparison', tok);
    const n = node('operator_not');
    if (value) n.inputs.OPERAND = value;
    return { node: n };
  }

  private postfix(): Value {
    const tok = this.tok;
    switch (tok.type) {
      case 'num':
        this.next();
        return { lit: tok.text };
      case 'str':
        this.next();
        return { lit: tok.text };
      case 'sym':
        if (tok.text === '(') {
          this.next();
          const inner = this.expression();
          this.expectSym(')');
          return inner;
        }
        break;
      case 'ident': {
        if (!tok.quoted && ((!this.py && tok.text === 'default') || (this.py && tok.text === 'None'))) {
          this.next();
          return null;
        }
        this.next();
        if (this.isSym('.')) return this.method(tok);
        if (this.isSym('(')) return this.call(tok);
        return this.name(tok);
      }
    }
    this.fail(`Expected a value here, found ${this.describe(tok)}`);
  }

  private name(tok: Token): Input {
    const param = this.params?.get(tok.text);
    if (param) {
      const n = node(param === 'b' ? 'argument_reporter_boolean' : 'argument_reporter_string_number');
      n.fields.VALUE = tok.text;
      return { node: n };
    }
    const decl = this.decls.get(tok.text);
    if (decl) {
      const n = node(decl.type === 'list' ? 'data_listcontents' : 'data_variable');
      n.fields[decl.type === 'list' ? 'LIST' : 'VARIABLE'] = tok.text;
      return { node: n };
    }
    this.fail(`Unknown name "${tok.text}". Declare a variable with ${this.declHint(tok.text, 'var')}`, tok);
  }

  private method(listTok: Token): Input {
    const decl = this.decls.get(listTok.text);
    if (!decl || decl.type !== 'list') this.fail(`"${listTok.text}" is not a list. Declare one with ${this.declHint(listTok.text, 'list')}`, listTok);
    this.next(); // .
    const nameTok = this.tok;
    if (nameTok.type !== 'ident') this.fail('Expected a list action like Add or Length');
    const spec = TABLES.methods.get(nameTok.text);
    if (!spec) this.fail(`Lists have no "${nameTok.text}". Try ${['add', 'remove', 'insert', 'replace', 'item', 'length', 'contains'].map((n) => methodName(BLOCKS.find((b) => b.name === n && b.args.some((a) => a.receiver))!, this.opts.skin)).join(', ')}`);
    this.next();
    const args = this.argList();
    const n = node(spec.op);
    n.fields.LIST = listTok.text;
    this.bind(n, spec, args, nameTok);
    return { node: n };
  }

  private call(nameTok: Token): Input {
    const spec = TABLES.fn.get(nameTok.text);
    const args = this.argList();
    if (spec) {
      const n = node(spec.op);
      this.bind(n, spec, args, nameTok);
      return { node: n };
    }
    // custom block (checked once everything has been read, since it may be defined further down)
    const n = node('procedures_call');
    args.forEach((a, i) => {
      if (a) n.inputs[String(i)] = a;
    });
    this.pending.push({ node: n, name: nameTok.text, argc: args.length, tok: nameTok });
    return { node: n };
  }

  /** Put call arguments into the right inputs and fields of a block. */
  private bind(n: Node, spec: BlockSpec, args: Value[], tok: Token): void {
    const slots = spec.args.filter((a) => !a.receiver);
    if (args.length !== slots.length) {
      const name = skinName(spec.name, this.opts.skin);
      this.fail(slots.length === 0 ? `${name} takes no values` : `${name} needs ${slots.length} value${slots.length === 1 ? '' : 's'} but got ${args.length}`, tok);
    }
    slots.forEach((a, i) => {
      const value = args[i];
      switch (a.kind) {
        case 'field':
        case 'bfield':
          if (!value || !('lit' in value)) this.fail(`${skinName(spec.name, this.opts.skin)}: ${a.name.toLowerCase().replace(/_/g, ' ')} must be plain text in quotes`, tok);
          n.fields[a.name] = value.lit;
          break;
        case 'var':
        case 'list': {
          const want = a.kind === 'list' ? 'data_listcontents' : 'data_variable';
          if (!value || !('node' in value) || value.node.op !== want) this.fail(`This needs the name of a ${a.kind === 'list' ? 'list' : 'variable'}`, tok);
          n.fields[a.name] = value.node.fields[a.kind === 'list' ? 'LIST' : 'VARIABLE'];
          break;
        }
        case 'b':
          if (value) {
            this.checkSlot('b', value, tok);
            n.inputs[a.name] = value;
          }
          break;
        default:
          if (value) n.inputs[a.name] = value;
      }
    });
  }

  private resolveCalls(): void {
    const external = new Map<string, Proc>();
    for (const proc of this.opts.externalProcs ?? []) external.set(procPrintedName(proc.proccode, this.opts.skin), proc);
    for (const { node: n, name, argc, tok } of this.pending) {
      const proc = this.defs.get(name) ?? external.get(name);
      if (!proc) {
        const skinNames = [...TABLES.fn.keys()].filter((k) => (this.py ? k === k.toLowerCase() : k[0] === k[0].toUpperCase()));
        const near = closest(name, [...skinNames, ...this.defs.keys(), ...external.keys()]);
        this.errors.push({ message: `"${name}" is not a block${near ? `. Did you mean ${near}?` : `. Define it with ${this.py ? `def ${name}():` : `void ${name}() { }`} or check the spelling`}`, line: tok.line, col: tok.col, len: tok.len });
        continue;
      }
      const types = procArgTypes(proc.proccode);
      if (types.length !== argc) {
        this.errors.push({ message: `${name} needs ${types.length} value${types.length === 1 ? '' : 's'} but got ${argc}`, line: tok.line, col: tok.col, len: tok.len });
        continue;
      }
      n.proc = { proccode: proc.proccode, argNames: [], warp: proc.warp };
      types.forEach((t, i) => {
        const input = n.inputs[String(i)];
        if (t === 'b' && input && ('lit' in input || !isBoolean(input.node))) this.errors.push({ message: 'This slot needs a true/false value', line: tok.line, col: tok.col, len: tok.len });
      });
    }
    this.errors.sort((a, b) => a.line - b.line || a.col - b.col);
  }
}

export function parse(source: string, options: ParseOptions): ParseResult {
  let lexed;
  try {
    lexed = lex(source, options.skin);
  } catch (error) {
    if (error instanceof SyntaxFail) {
      return { scripts: [], decls: [], kept: new Set(), errors: [{ message: error.message, line: error.line, col: error.col, len: error.len }] };
    }
    throw error;
  }
  return new Parser(lexed.tokens, lexed.kept, options).run();
}
