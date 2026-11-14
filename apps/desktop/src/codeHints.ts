import { BLOCKS, KEYWORDS, type ArgSpec, type BlockSpec, type Skin, allDocs, matchScore, skinName } from '@codewarp/core';

/*
 * The popup that shows up next to where you type in text mode: suggestions that forgive typos ("mv" finds
 * Move, "gotoxy" finds GoToXY), values for menu-like arguments ("space", sprite names...), and a tip with
 * the block's signature while you are inside its brackets.
 */

export interface HintHost {
  skin(): Skin;
  vm(): any;
  /** Names of declared variables (type 'var') and lists (type 'list'). */
  declared(): Map<string, 'var' | 'list'>;
}

interface Item {
  label: string;
  /** Text that replaces what has been typed. */
  insert: string;
  /** Move the caret this many characters back from the end of the inserted text. */
  back: number;
  detail: string;
  kind: 'block' | 'event' | 'word' | 'var' | 'custom' | 'value' | 'method';
  score: number;
}

interface Context {
  /** Start of the text that will be replaced. */
  from: number;
  /** Where the caret is. */
  to: number;
  query: string;
  items: Item[];
  tip: { name: string; params: string[]; active: number; desc: string } | null;
}

const KEYS = ['space', 'up arrow', 'down arrow', 'right arrow', 'left arrow', 'any', ...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')];

const FIELD_VALUES: Record<string, string[]> = {
  STYLE: ['left-right', "don't rotate", 'all around'],
  FRONT_BACK: ['front', 'back'],
  FORWARD_BACKWARD: ['forward', 'backward'],
  NUMBER_NAME: ['number', 'name'],
  STOP_OPTION: ['all', 'this script', 'other scripts in sprite'],
  DRAG_MODE: ['draggable', 'not draggable'],
  CURRENTMENU: ['YEAR', 'MONTH', 'DATE', 'DAYOFWEEK', 'HOUR', 'MINUTE', 'SECOND'],
  OPERATOR: ['abs', 'floor', 'ceiling', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'ln', 'log', 'e ^', '10 ^'],
  WHENGREATERTHANMENU: ['LOUDNESS', 'TIMER'],
  KEY_OPTION: KEYS,
};

const SNIPPETS: Record<Skin, Record<string, { text: string; detail: string }>> = {
  csharp: {
    when: { text: 'when $0 {\n    \n}', detail: 'start a script' },
    if: { text: 'if ($0) {\n    \n}', detail: 'if <> then' },
    else: { text: 'else {\n    $0\n}', detail: 'else part' },
    repeat: { text: 'repeat ($0) {\n    \n}', detail: 'repeat (10)' },
    forever: { text: 'forever {\n    $0\n}', detail: 'forever' },
    until: { text: 'until ($0) {\n    \n}', detail: 'repeat until <>' },
    var: { text: 'var $0;', detail: 'declare a variable' },
    list: { text: 'list $0;', detail: 'declare a list' },
    void: { text: 'void $0() {\n    \n}', detail: 'define your own block' },
    local: { text: 'local var $0;', detail: 'variable for this sprite only' },
    cloud: { text: 'cloud var $0;', detail: 'cloud variable' },
    loose: { text: 'loose {\n    $0\n}', detail: 'blocks with no event' },
  },
  python: {
    when: { text: 'when $0:\n    ', detail: 'start a script' },
    if: { text: 'if $0:\n    ', detail: 'if <> then' },
    elif: { text: 'elif $0:\n    ', detail: 'else if' },
    else: { text: 'else:\n    $0', detail: 'else part' },
    repeat: { text: 'repeat $0:\n    ', detail: 'repeat (10)' },
    forever: { text: 'forever:\n    $0', detail: 'forever' },
    until: { text: 'until $0:\n    ', detail: 'repeat until <>' },
    var: { text: 'var $0', detail: 'declare a variable' },
    list: { text: 'list $0', detail: 'declare a list' },
    def: { text: 'def $0():\n    ', detail: 'define your own block' },
    local: { text: 'local var $0', detail: 'variable for this sprite only' },
    cloud: { text: 'cloud var $0', detail: 'cloud variable' },
    loose: { text: 'loose:\n    $0', detail: 'blocks with no event' },
  },
};

const LABELS = new Map(allDocs().map((d) => [d.op, d]));
const argLabel = (a: ArgSpec): string => a.name.toLowerCase().replace(/\d+$/, '').replace(/_/g, ' ');
const typeLabel = (a: ArgSpec): string =>
  ({ n: 'number', s: 'text', c: 'colour text like "#ff0000"', b: 'true/false', menu: 'choice in quotes', field: 'choice in quotes', bfield: 'message in quotes', bcast: 'message in quotes', var: 'variable name', list: 'list name', stack: 'blocks' })[a.kind] ?? '';

export class CodeHints {
  private readonly el = document.createElement('div');
  private items: Item[] = [];
  private selected = 0;
  private ctx: Context | null = null;
  private forced = false;
  private metrics = { char: 8, line: 20, padLeft: 64, padTop: 10 };

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly layer: HTMLElement,
    private readonly host: HintHost,
  ) {
    this.el.className = 'cw-hints';
    this.el.hidden = true;
    // Keep the textarea focused when clicking the popup.
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    layer.appendChild(this.el);
    input.addEventListener('input', () => this.update());
    input.addEventListener('click', () => this.update());
    input.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(e.key)) this.update();
    });
    input.addEventListener('blur', () => this.hide());
    input.addEventListener('scroll', () => this.hide());
    this.measure();
  }

  private measure(): void {
    const probe = document.createElement('span');
    probe.className = 'cw-code-text';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;padding:0;left:0;top:0';
    probe.textContent = 'M'.repeat(100);
    this.layer.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 100;
    probe.remove();
    if (width > 0) this.metrics.char = width;
    const style = getComputedStyle(this.input);
    this.metrics.line = parseFloat(style.lineHeight) || 20;
    this.metrics.padTop = parseFloat(style.paddingTop) || 10;
    this.metrics.padLeft = this.input.offsetLeft + (parseFloat(style.paddingLeft) || 12);
  }

  get open(): boolean {
    return !this.el.hidden && this.items.length > 0;
  }

  hide(): void {
    this.el.hidden = true;
    this.items = [];
    this.forced = false;
  }

  /** Open the list even when nothing has been typed (Ctrl+Space). */
  force(): void {
    this.forced = true;
    this.update();
  }

  // ---- keys ----

  /** Handle a key press. Returns true when the popup used it. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      this.force();
      return true;
    }
    if (!this.open) return false;
    switch (e.key) {
      case 'ArrowDown':
        this.move(1);
        break;
      case 'ArrowUp':
        this.move(-1);
        break;
      case 'Enter':
      case 'Tab':
        if (e.shiftKey || e.ctrlKey) return false;
        this.accept(this.items[this.selected]);
        break;
      case 'Escape':
        this.hide();
        break;
      default:
        return false;
    }
    e.preventDefault();
    return true;
  }

  private move(by: number): void {
    this.selected = (this.selected + by + this.items.length) % this.items.length;
    this.render();
  }

  private accept(item: Item | undefined): void {
    const ctx = this.ctx;
    if (!item || !ctx) return;
    this.input.focus();
    this.input.setSelectionRange(ctx.from, ctx.to);
    const marker = item.insert.indexOf('$0');
    if (marker >= 0) {
      const text = item.insert.replace('$0', '');
      document.execCommand('insertText', false, text);
      const at = ctx.from + marker;
      this.input.setSelectionRange(at, at);
    } else {
      document.execCommand('insertText', false, item.insert);
      const at = ctx.from + item.insert.length - item.back;
      this.input.setSelectionRange(at, at);
    }
    this.hide();
    // Opening a call straight away shows its tip.
    window.setTimeout(() => this.update(), 0);
  }

  // ---- working out what to suggest ----

  update(): void {
    const ctx = this.analyse();
    this.ctx = ctx;
    if (!ctx || (ctx.items.length === 0 && !ctx.tip)) {
      this.hide();
      return;
    }
    this.items = ctx.items;
    this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1));
    if (ctx.items.length > 0 && ctx.query !== this.lastQuery) this.selected = 0;
    this.lastQuery = ctx.query;
    this.render();
  }
  private lastQuery = '';

  private analyse(): Context | null {
    const { selectionStart: caret, selectionEnd, value } = this.input;
    if (caret !== selectionEnd) return null;
    const before = value.slice(0, caret);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.slice(lineStart);
    const skin = this.host.skin();
    // inside a string?
    const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
    const stringOpen = quotes % 2 === 1 ? line.lastIndexOf('"') : -1;
    const call = this.enclosingCall(stringOpen >= 0 ? before.slice(0, lineStart + stringOpen) : before);
    if (stringOpen >= 0) {
      const open = stringOpen;
      const typed = line.slice(open + 1);
      const items = call ? this.valuesFor(call, typed) : [];
      return { from: lineStart + open + 1, to: caret, query: typed, items, tip: call ? this.tipFor(call) : null };
    }

    const word = /[\p{L}\p{N}_]*$/u.exec(line)![0];
    const from = caret - word.length;
    const prefix = line.slice(0, line.length - word.length);
    const tip = call ? this.tipFor(call) : null;
    if (/^\s*\/\/|^\s*#/.test(line)) return null;
    if (word === '' && !this.forced) return tip ? { from, to: caret, query: '', items: [], tip } : null;
    if (/\d/.test(word[0] ?? '')) return tip ? { from, to: caret, query: word, items: [], tip } : null;

    let items: Item[] = [];
    // after "when": event names
    if (/(^|\s)when\s+$/.test(prefix)) items = this.hatItems(word, skin);
    else if (/([\p{L}\p{N}_`]+)\.$/u.test(prefix)) {
      const owner = /([\p{L}\p{N}_`]+)\.$/u.exec(prefix)![1];
      items = this.host.declared().get(owner) === 'list' ? this.methodItems(word, skin) : [];
    } else items = this.generalItems(word, skin, prefix);
    if (items.length === 1 && items[0].label === word && !this.forced) items = [];
    return { from, to: caret, query: word, items: items.slice(0, 8), tip };
  }

  /** The call the caret is inside, with which argument it is on. */
  private enclosingCall(before: string): { name: string; index: number; receiver: string } | null {
    let depth = 0;
    let commas = 0;
    let inString = false;
    for (let i = before.length - 1; i >= Math.max(0, before.length - 1500); i--) {
      const ch = before[i];
      if (ch === '"' && before[i - 1] !== '\\') inString = !inString;
      if (inString) continue;
      if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if (ch === '(' || ch === '[' || ch === '{') {
        if (depth > 0) depth--;
        else if (ch === '(') {
          const m = /([\p{L}\p{N}_`]+)(?:\.([\p{L}\p{N}_]+))?\s*$/u.exec(before.slice(0, i));
          if (!m) return null;
          return m[2] ? { name: m[2], index: commas, receiver: m[1] } : { name: m[1], index: commas, receiver: '' };
        } else return null;
      } else if (ch === ',' && depth === 0) commas++;
    }
    return null;
  }

  private lookup(name: string, receiver: string): BlockSpec | undefined {
    const skin = this.host.skin();
    for (const spec of BLOCKS) {
      if (spec.kind === 'C') continue;
      if (skinName(spec.name, skin) !== name && spec.name !== name) continue;
      const method = spec.args.some((a) => a.receiver);
      if (Boolean(receiver) === method) return spec;
    }
    return undefined;
  }

  /** Custom blocks, read from the definitions in the text so they show up before they are applied. */
  private customBlocks(): { name: string; params: string[] }[] {
    const out: { name: string; params: string[] }[] = [];
    const re = /^\s*(?:void|def)\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(([^)]*)\)/gmu;
    for (let m = re.exec(this.input.value); m; m = re.exec(this.input.value)) {
      const params = m[2]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (this.host.skin() === 'csharp' ? p.split(/\s+/).pop()! : p.split(':')[0].trim()));
      out.push({ name: m[1], params });
    }
    return out;
  }

  private tipFor(call: { name: string; index: number; receiver: string }): Context['tip'] {
    const spec = this.lookup(call.name, call.receiver);
    if (spec) {
      const slots = spec.args.filter((a) => !a.receiver);
      const doc = LABELS.get(spec.op);
      return {
        name: call.receiver ? `${call.receiver}.${call.name}` : call.name,
        params: slots.map((a) => `${argLabel(a)}: ${typeLabel(a)}`),
        active: call.index,
        desc: doc ? `${doc.label}  —  ${doc.desc}` : '',
      };
    }
    const custom = this.customBlocks().find((c) => c.name === call.name);
    if (custom) return { name: custom.name, params: custom.params, active: call.index, desc: 'Your own block' };
    return null;
  }

  private sprites(): string[] {
    return (this.host.vm().runtime.targets as any[]).filter((t) => t.isOriginal && !t.isStage).map((t) => String(t.getName()));
  }

  private valuesFor(call: { name: string; index: number; receiver: string }, typed: string): Item[] {
    const spec = this.lookup(call.name, call.receiver);
    if (!spec) return [];
    const slots = spec.args.filter((a) => !a.receiver);
    const arg = slots[call.index];
    if (!arg) return [];
    const vm = this.host.vm();
    const target = vm.editingTarget;
    const stage = vm.runtime.getTargetForStage?.();
    let values: string[] = [];
    if (arg.kind === 'bcast' || arg.kind === 'bfield') {
      values = Object.values<any>(stage?.variables ?? {}).filter((v) => v.type === 'broadcast_msg').map((v) => String(v.name));
    } else if (arg.kind === 'menu') {
      const sprites = this.sprites();
      switch (arg.shadow) {
        case 'motion_goto_menu':
        case 'motion_glideto_menu':
          values = ['_mouse_', '_random_', ...sprites];
          break;
        case 'motion_pointtowards_menu':
        case 'sensing_distancetomenu':
          values = ['_mouse_', ...sprites];
          break;
        case 'looks_costume':
          values = (target?.getCostumes?.() ?? []).map((c: any) => String(c.name));
          break;
        case 'looks_backdrops':
          values = (stage?.getCostumes?.() ?? []).map((c: any) => String(c.name));
          break;
        case 'sound_sounds_menu':
          values = (target?.getSounds?.() ?? []).map((s: any) => String(s.name));
          break;
        case 'control_create_clone_of_menu':
          values = ['_myself_', ...sprites];
          break;
        case 'sensing_touchingobjectmenu':
          values = ['_mouse_', '_edge_', ...sprites];
          break;
        case 'sensing_keyoptions':
          values = KEYS;
          break;
        case 'sensing_of_object_menu':
          values = ['_stage_', ...sprites];
          break;
      }
    } else if (arg.kind === 'field') {
      if (arg.name === 'EFFECT') values = spec.op.startsWith('sound') ? ['PITCH', 'PAN'] : ['COLOR', 'FISHEYE', 'WHIRL', 'PIXELATE', 'MOSAIC', 'BRIGHTNESS', 'GHOST'];
      else if (arg.name === 'BACKDROP') values = (stage?.getCostumes?.() ?? []).map((c: any) => String(c.name));
      else if (arg.name === 'PROPERTY') values = ['x position', 'y position', 'direction', 'costume #', 'costume name', 'size', 'volume', ...this.host.declared().keys()];
      else values = FIELD_VALUES[arg.name] ?? [];
    }
    return values
      .map((v) => ({ label: v, insert: v, back: 0, detail: argLabel(arg), kind: 'value' as const, score: matchScore(typed, v) }))
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private hatItems(word: string, skin: Skin): Item[] {
    return BLOCKS.filter((b) => b.kind === 'H')
      .map((spec) => {
        const name = skinName(spec.name, skin);
        const slots = spec.args.filter((a) => !a.receiver);
        return { label: name, insert: slots.length ? `${name}()` : name, back: slots.length ? 1 : 0, detail: LABELS.get(spec.op)?.label ?? '', kind: 'event' as const, score: matchScore(word, name) };
      })
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private methodItems(word: string, skin: Skin): Item[] {
    return BLOCKS.filter((b) => b.args.some((a) => a.receiver))
      .map((spec) => {
        const name = skinName(spec.name, skin);
        const slots = spec.args.filter((a) => !a.receiver);
        return { label: name, insert: `${name}()`, back: slots.length ? 1 : 0, detail: `(${slots.map(argLabel).join(', ')})`, kind: 'method' as const, score: matchScore(word, name) };
      })
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private generalItems(word: string, skin: Skin, prefix: string): Item[] {
    const atLineStart = prefix.trim() === '';
    const items: Item[] = [];
    // Words that start things (only at the beginning of a line).
    if (atLineStart) {
      for (const [kw, snip] of Object.entries(SNIPPETS[skin])) {
        const score = matchScore(word, kw);
        if (score > 0) items.push({ label: kw, insert: snip.text, back: 0, detail: snip.detail, kind: 'word', score: score + 1 });
      }
    }
    for (const spec of BLOCKS) {
      if (spec.kind === 'C' || spec.kind === 'H' || spec.args.some((a) => a.receiver)) continue;
      const name = skinName(spec.name, skin);
      const score = matchScore(word, name);
      if (score <= 0) continue;
      const slots = spec.args;
      const doc = LABELS.get(spec.op);
      items.push({
        label: name,
        insert: `${name}()`,
        back: slots.length ? 1 : 0,
        detail: doc?.label ?? '',
        kind: 'block',
        score,
      });
    }
    for (const [name, type] of this.host.declared()) {
      const score = matchScore(word, name);
      if (score > 0) items.push({ label: name, insert: /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) && !KEYWORDS.has(name) ? name : `\`${name}\``, back: 0, detail: type === 'list' ? 'list' : 'variable', kind: 'var', score: score + 0.5 });
    }
    for (const c of this.customBlocks()) {
      const score = matchScore(word, c.name);
      if (score > 0) items.push({ label: c.name, insert: `${c.name}()`, back: c.params.length ? 1 : 0, detail: `your block (${c.params.join(', ')})`, kind: 'custom', score: score + 0.5 });
    }
    // Hide words that are only a worse match than a block with the same spelling.
    return items.sort((a, b) => b.score - a.score);
  }

  // ---- drawing ----

  private caretXY(): { x: number; y: number } {
    const { selectionStart: caret, value } = this.input;
    const before = value.slice(0, caret);
    const line = before.split('\n').length - 1;
    const col = before.length - (before.lastIndexOf('\n') + 1);
    return { x: this.metrics.padLeft + col * this.metrics.char, y: this.metrics.padTop + line * this.metrics.line };
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.el.replaceChildren();
    if (ctx.tip) {
      const tip = document.createElement('div');
      tip.className = 'cw-hint-tip';
      const head = document.createElement('div');
      head.className = 'cw-hint-sig';
      head.append(`${ctx.tip.name}(`);
      ctx.tip.params.forEach((p, i) => {
        const span = document.createElement('span');
        span.textContent = p.split(':')[0];
        span.title = p;
        if (i === ctx.tip!.active) span.className = 'cw-hint-active';
        head.appendChild(span);
        if (i < ctx.tip!.params.length - 1) head.append(', ');
      });
      head.append(')');
      tip.appendChild(head);
      const active = ctx.tip.params[ctx.tip.active];
      if (active && active.includes(':')) {
        const line = document.createElement('div');
        line.className = 'cw-hint-line';
        line.textContent = `${active.split(':')[0]}: ${active.split(':').slice(1).join(':').trim()}`;
        tip.appendChild(line);
      }
      if (ctx.tip.desc) {
        const d = document.createElement('div');
        d.className = 'cw-hint-desc';
        d.textContent = ctx.tip.desc;
        tip.appendChild(d);
      }
      this.el.appendChild(tip);
    }
    if (this.items.length > 0) {
      const list = document.createElement('div');
      list.className = 'cw-hint-list';
      this.items.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = `cw-hint-row${i === this.selected ? ' selected' : ''}`;
        const badge = document.createElement('span');
        badge.className = `cw-hint-badge cw-hb-${item.kind}`;
        badge.textContent = { block: 'ƒ', event: '⚑', word: 'K', var: 'x', custom: '★', value: '“', method: '.' }[item.kind];
        const name = document.createElement('span');
        name.className = 'cw-hint-name';
        name.textContent = item.label;
        const detail = document.createElement('span');
        detail.className = 'cw-hint-detail';
        detail.textContent = item.detail;
        row.append(badge, name, detail);
        row.addEventListener('click', () => this.accept(item));
        list.appendChild(row);
      });
      const foot = document.createElement('div');
      foot.className = 'cw-hint-foot';
      foot.textContent = 'Enter or Tab to use · Esc to close';
      list.appendChild(foot);
      this.el.appendChild(list);
    }
    this.el.hidden = false;
    // Above the line being typed, unless there is no room.
    const { x, y } = this.caretXY();
    this.el.style.left = `${Math.max(8, x)}px`;
    this.el.style.top = '0px';
    const height = this.el.offsetHeight;
    const scroller = this.layer.parentElement;
    const roomAbove = y - (scroller?.scrollTop ?? 0) - height - 6;
    this.el.style.top = `${roomAbove >= 0 ? y - height - 6 : y + this.metrics.line + 4}px`;
    const maxLeft = this.layer.clientWidth - this.el.offsetWidth - 8;
    if (maxLeft > 0) this.el.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`;
  }
}

