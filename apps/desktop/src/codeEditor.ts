import { BLOCKS, KEYWORDS, type ParseError, type Skin, type TextChange, convertText, diffText, mapOffset, parse, skinName } from '@codewarp/core';
import type { BlocksEditor } from './blocksEditor';
import { applyParsed, externalProcs, generate, type Snapshot } from './codeBridge';
import { getCodeSkin, saveCodeSkin } from './settings';
import { logDiag } from './diagnostics';
import { CodeHints } from './codeHints';
import { CodeBank } from './codeBank';
import { type TextHub, type TextSession } from './codeSession';
import { lineAndColumn, measureMetrics, visualColumn, type Metrics } from './codeGeometry';

const APPLY_DELAY_MS = 450;
const CARET_LABEL_MS = 3000;
const REFRESH_DELAY_MS = 250;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BLOCK_NAMES = new Set<string>();
for (const spec of BLOCKS) for (const skin of ['csharp', 'python'] as Skin[]) BLOCK_NAMES.add(skinName(spec.name, skin));

interface Piece {
  text: string;
  cls: string;
}

/** Text mode: write scripts as C#-style or Python-style code. The text and the blocks stay the same project. */
/** What the editor needs to read and change the blocks. (A test can give it a pretend set of blocks.) */
export interface CodeBridge {
  generate: typeof generate;
  applyParsed: typeof applyParsed;
  externalProcs: typeof externalProcs;
}

export class CodeEditor {
  private readonly root = document.createElement('div');
  private readonly input = document.createElement('textarea');
  private readonly highlight = document.createElement('pre');
  private readonly gutter = document.createElement('div');
  private readonly statusEl = document.createElement('span');
  private readonly errorsEl = document.createElement('div');
  private readonly skinButtons = new Map<Skin, HTMLButtonElement>();
  private hints!: CodeHints;
  private readonly bank = new CodeBank((code, inline) => this.insertCode(code, inline));
  private bankButton!: HTMLButtonElement;

  private skin: Skin = getCodeSkin();
  private shown = false;
  private dirty = false;
  private applying = false;
  private snapshot: Snapshot = { text: '', base: [], keptIds: [] };
  private targetId = '';
  private errors: ParseError[] = [];
  private declared = new Set<string>();
  private applyTimer: number | undefined;
  private refreshTimer: number | undefined;

  private session: TextSession | null = null;
  private inner!: HTMLElement;
  private readonly caretLayer = document.createElement('div');
  private readonly peopleEl = document.createElement('div');
  private metrics: Metrics | null = null;
  private caretFrame = 0;
  private caretSeen = new Map<string, { key: string; since: number }>();
  private caretIdleTimer: number | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly vm: any,
    private readonly editor: BlocksEditor,
    private readonly hub: TextHub,
    private readonly bridge: CodeBridge = { generate, applyParsed, externalProcs },
  ) {
    this.build();
    this.editor.onBlocksChanged(() => this.blocksChanged());
    this.vm.addListener('workspaceUpdate', () => this.targetMaybeChanged());
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === this.input) this.caretMoved();
    });
    window.addEventListener('resize', () => this.drawCarets());
  }

  // ---- layout ----

  private build(): void {
    this.root.className = 'cw-code';
    this.root.hidden = true;

    const bar = document.createElement('div');
    bar.className = 'cw-code-bar';
    const seg = document.createElement('div');
    seg.className = 'cw-seg';
    for (const [skin, label] of [['csharp', 'C#'], ['python', 'Python']] as [Skin, string][]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => this.setSkin(skin));
      this.skinButtons.set(skin, b);
      seg.appendChild(b);
    }
    this.statusEl.className = 'cw-code-status';
    this.bankButton = document.createElement('button');
    this.bankButton.type = 'button';
    this.bankButton.className = 'cw-code-bank-btn';
    this.bankButton.textContent = 'Code bank';
    this.bankButton.title = 'Every block as code, with what it does';
    this.bankButton.addEventListener('click', () => {
      this.bankButton.classList.toggle('active', this.bank.toggle());
    });
    this.peopleEl.className = 'cw-code-people';
    bar.append(seg, this.statusEl, this.peopleEl, this.bankButton);

    const body = document.createElement('div');
    body.className = 'cw-code-body';
    const inner = document.createElement('div');
    inner.className = 'cw-code-inner';
    this.gutter.className = 'cw-code-gutter';
    this.highlight.className = 'cw-code-text cw-code-hl';
    this.highlight.setAttribute('aria-hidden', 'true');
    this.input.className = 'cw-code-text cw-code-input';
    this.input.spellcheck = false;
    this.input.setAttribute('wrap', 'off');
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocomplete', 'off');
    this.caretLayer.className = 'cw-rcarets';
    this.caretLayer.setAttribute('aria-hidden', 'true');
    inner.append(this.gutter, this.highlight, this.input, this.caretLayer);
    this.inner = inner;
    body.appendChild(inner);
    const main = document.createElement('div');
    main.className = 'cw-code-main';
    main.append(body, this.bank.element);

    this.errorsEl.className = 'cw-code-errors';
    this.errorsEl.hidden = true;
    this.root.append(bar, main, this.errorsEl);
    this.host.appendChild(this.root);

    this.input.addEventListener('input', () => this.typed());
    this.input.addEventListener('keydown', (e) => this.keydown(e));
    this.input.addEventListener('focus', () => this.caretMoved());
    this.hints = new CodeHints(this.input, inner, {
      skin: () => this.skin,
      vm: () => this.vm,
      declared: () => this.declaredNames(),
    });
    this.bank.setSkin(this.skin);
    this.updateSkinButtons();
  }

  /** Variables and lists named in the text (read straight from it, so new ones are known as soon as they are typed). */
  private declaredNames(): Map<string, 'var' | 'list'> {
    const out = new Map<string, 'var' | 'list'>();
    const text = this.input.value;
    const add = (raw: string, kind: 'var' | 'list') => out.set(raw.startsWith('`') ? raw.slice(1, -1) : raw, kind);
    const id = '(`[^`\\n]+`|[\\p{L}_][\\p{L}\\p{N}_]*)';
    // C#: [Cloud] public var x;  private var x;  public List<var> items;   (older: var x; list items;)
    for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:\\[Cloud\\][ \\t]*)?(?:(?:public|private|cloud|local|global)[ \\t]+)*(?:(var)|(list)|List<[^>\\n]*>)[ \\t]+${id}`, 'gmu'))) add(m[3], m[2] || m[0].includes('List<') ? 'list' : 'var');
    // Python: x: Variable   x: Local[Variable]   items: List
    for (const m of text.matchAll(new RegExp(`^${id}[ \\t]*:[ \\t]*(?:(?:Local|Cloud)\\[[ \\t]*)?(Variable|List)\\b`, 'gmu'))) add(m[1], m[2] === 'List' ? 'list' : 'var');
    return out;
  }

  /** Put code from the Code Bank at the cursor, on its own line, indented to match. */
  private insertCode(code: string, inline: boolean): void {
    const input = this.input;
    if (input.readOnly) return;
    input.focus();
    const { selectionStart: a, value } = input;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    const before = value.slice(lineStart, a);
    const indent = /^[ \t]*/.exec(before)![0];
    const body = code
      .replace(/^[ \t]*\.\.\.[ \t]*$/gm, '')
      .split('\n')
      .map((l, i) => (i === 0 ? l : indent + l))
      .join('\n');
    // a statement goes on a fresh line; a value goes where the cursor is
    const text = !inline && before.trim() !== '' ? `\n${indent}${body}` : body;
    document.execCommand('insertText', false, text);
    this.typed();
  }

  private updateSkinButtons(): void {
    for (const [skin, b] of this.skinButtons) b.classList.toggle('active', skin === this.skin);
  }

  // ---- showing and hiding ----

  show(): void {
    this.shown = true;
    this.root.hidden = false;
    this.targetId = this.vm.editingTarget?.id ?? '';
    this.metrics = measureMetrics(this.input, this.inner);
    this.openSession();
    this.input.focus();
  }

  hide(): void {
    if (!this.shown) return;
    window.clearTimeout(this.applyTimer);
    window.clearTimeout(this.refreshTimer);
    if (this.dirty && this.session?.ready && this.session.leader) this.applyNow();
    this.closeSession();
    this.shown = false;
    this.root.hidden = true;
  }

  get isShown(): boolean {
    return this.shown;
  }

  // ---- the shared text ----

  /** Start (or join) the shared text for the sprite being edited. */
  private openSession(): void {
    this.closeSession();
    const sprite: string | undefined = this.vm.editingTarget?.getName?.();
    if (!sprite) return;
    this.dirty = false;
    this.errors = [];
    this.input.readOnly = true;
    this.setStatus('busy', 'Getting the shared text…');
    const session = this.hub.open(sprite, this.skin, () => this.seedText(), {
      ready: () => this.sessionReady(),
      changed: (changes, from) => this.remoteChanged(changes, from),
      skin: (skin) => this.remoteSkin(skin),
      leader: (isLeader) => this.leaderChanged(isLeader),
      carets: () => {
        this.updatePeople();
        this.drawCarets();
      },
    });
    this.session = session;
    session.start();
  }

  private closeSession(): void {
    this.session?.close();
    this.session = null;
    this.caretLayer.replaceChildren();
    this.peopleEl.replaceChildren();
  }

  /** What the text starts as when nobody else has it open: the blocks, written as code. */
  private seedText(): string {
    try {
      return this.bridge.generate(this.vm, this.skin).text;
    } catch (error) {
      console.error('Could not write the blocks as text', error);
      logDiag('code', 'generate failed', String(error));
      return '';
    }
  }

  private sessionReady(): void {
    const session = this.session;
    if (!session) return;
    this.input.readOnly = false;
    this.skin = session.skin as Skin;
    this.updateSkinButtons();
    this.bank.setSkin(this.skin);
    try {
      this.snapshot = this.bridge.generate(this.vm, this.skin);
    } catch (error) {
      console.error('Could not write the blocks as text', error);
      logDiag('code', 'generate failed', String(error));
      this.snapshot = { text: '', base: [], keptIds: [] };
    }
    this.input.value = session.text();
    this.dirty = this.input.value !== this.snapshot.text;
    this.errors = [];
    this.render();
    this.showErrors();
    this.updatePeople();
    this.drawCarets();
    this.caretMoved();
    if (this.dirty) this.scheduleApply();
    else this.setStatus('ok', 'Matches the blocks');
  }

  /** Other people's typing arrived: put it in the text box without moving what you are doing. */
  private remoteChanged(changes: TextChange[], _from: string | null): void {
    if (changes.length === 0) return;
    const input = this.input;
    let value = input.value;
    let a = input.selectionStart;
    let b = input.selectionEnd;
    for (const c of changes) {
      value = value.slice(0, c.pos) + c.ins + value.slice(c.pos + c.del);
      a = mapOffset(a, c);
      b = mapOffset(b, c);
    }
    if (value !== input.value) {
      const backward = input.selectionDirection === 'backward';
      input.value = value;
      input.setSelectionRange(a, b, backward ? 'backward' : 'forward');
    }
    this.hints.hide();
    this.afterTextChange();
    this.drawCarets();
  }

  private remoteSkin(skin: string): void {
    if (skin !== 'csharp' && skin !== 'python') return;
    if (skin === this.skin) return;
    this.skin = skin;
    this.updateSkinButtons();
    this.bank.setSkin(skin);
    // The text is about to be rewritten in the new style: the blocks' reference copy has to be in it too.
    if (this.session?.leader) {
      try {
        this.snapshot = this.bridge.generate(this.vm, skin);
      } catch (error) {
        console.error(error);
      }
    }
    this.render();
  }

  private leaderChanged(isLeader: boolean): void {
    if (!isLeader) {
      window.clearTimeout(this.applyTimer);
      this.setStatus('ok', 'Shared with others');
      return;
    }
    // Whoever was putting the text into the blocks left: that is now our job.
    try {
      this.snapshot = this.bridge.generate(this.vm, this.skin);
    } catch (error) {
      console.error(error);
    }
    this.dirty = true;
    this.scheduleApply();
  }

  /** Tell the others where the cursor is. */
  private caretMoved(): void {
    const session = this.session;
    if (!session?.ready) return;
    const { selectionStart: a, selectionEnd: b, selectionDirection } = this.input;
    session.setCaret(a, b, selectionDirection === 'backward' ? a : b);
  }

  private updatePeople(): void {
    this.peopleEl.replaceChildren();
    for (const person of this.session?.people() ?? []) {
      const chip = document.createElement('span');
      chip.className = 'cw-code-person';
      chip.style.setProperty('--cursor-color', person.color);
      chip.textContent = person.name;
      chip.title = `${person.name} has this code open`;
      this.peopleEl.appendChild(chip);
    }
  }

  /** Draw other people's cursors and selections. */
  private drawCarets(): void {
    if (this.caretFrame) return;
    this.caretFrame = requestAnimationFrame(() => {
      this.caretFrame = 0;
      this.caretLayer.replaceChildren();
      const session = this.session;
      if (!session?.ready || !this.shown) return;
      if (!this.metrics || this.metrics.char <= 0) this.metrics = measureMetrics(this.input, this.inner);
      const m = this.metrics;
      const value = this.input.value;
      const lines = value.split('\n');
      const frag = document.createDocumentFragment();
      let soonest = Infinity;
      for (const c of session.remoteCarets()) {
        const color = c.color || 'var(--accent)';
        const start = lineAndColumn(value, c.from);
        const end = lineAndColumn(value, c.to);
        if (c.from !== c.to) {
          for (let line = start.line; line <= end.line; line++) {
            const from = line === start.line ? start.col : 0;
            const to = line === end.line ? end.col : visualColumn(lines[line] ?? '') + 1;
            if (to <= from) continue;
            const rect = document.createElement('div');
            rect.className = 'cw-rsel';
            rect.style.cssText = `left:${m.padLeft + from * m.char}px;top:${m.padTop + line * m.line}px;width:${(to - from) * m.char}px;height:${m.line}px;--cursor-color:${color}`;
            frag.appendChild(rect);
          }
        }
        const head = lineAndColumn(value, c.head);
        const caret = document.createElement('div');
        caret.className = 'cw-rcaret';
        caret.style.cssText = `left:${m.padLeft + head.col * m.char}px;top:${m.padTop + head.line * m.line}px;height:${m.line}px;--cursor-color:${color}`;
        // The name tag shows while someone is moving or typing, then shrinks away so it does not cover your code.
        const key = `${c.from}:${c.to}:${c.head}`;
        const seen = this.caretSeen.get(c.id);
        if (!seen || seen.key !== key) this.caretSeen.set(c.id, { key, since: performance.now() });
        const idle = performance.now() - (this.caretSeen.get(c.id)?.since ?? 0) > CARET_LABEL_MS;
        if (!idle) soonest = Math.min(soonest, CARET_LABEL_MS - (performance.now() - this.caretSeen.get(c.id)!.since) + 50);
        const label = document.createElement('div');
        label.className = `cw-rcaret-label${head.line === 0 ? ' cw-below' : ''}${idle ? ' cw-idle' : ''}`;
        label.textContent = c.name;
        caret.appendChild(label);
        frag.appendChild(caret);
      }
      this.caretLayer.appendChild(frag);
      window.clearTimeout(this.caretIdleTimer);
      if (soonest < Infinity) this.caretIdleTimer = window.setTimeout(() => this.drawCarets(), soonest);
    });
  }

  // ---- text <-> blocks ----

  /** The blocks changed (by you, or by a collaborator): update the text unless you are in the middle of typing. */
  private blocksChanged(): void {
    if (!this.shown || this.applying || !this.session?.ready || !this.session.leader) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(false), REFRESH_DELAY_MS);
  }

  private targetMaybeChanged(): void {
    if (!this.shown) return;
    const id = this.vm.editingTarget?.id ?? '';
    if (id === this.targetId) return;
    this.targetId = id;
    this.dirty = false;
    window.clearTimeout(this.applyTimer);
    this.openSession();
  }

  /** Write the blocks out as text (only the person who puts text into the blocks does this). */
  refresh(force: boolean): void {
    const session = this.session;
    if (!this.shown || this.applying || !session?.ready) return;
    if (!session.leader && !force) return;
    if (this.dirty && !force) return;
    if (!this.vm.editingTarget) return;
    let snap: Snapshot;
    try {
      snap = this.bridge.generate(this.vm, this.skin);
    } catch (error) {
      console.error('Could not write the blocks as text', error);
      logDiag('code', 'generate failed', String(error));
      this.setStatus('error', 'Could not turn these blocks into text (see Settings > Diagnostics)');
      return;
    }
    this.snapshot = snap;
    this.dirty = false;
    if (snap.text !== this.input.value) this.replaceText(snap.text);
    this.errors = [];
    this.render();
    this.showErrors();
    this.setStatus('ok', 'Matches the blocks');
  }

  /** Change the whole text to `text`, sending only the part that differs, and keep the cursor where it was. */
  private replaceText(text: string): void {
    const session = this.session;
    if (!session?.ready) return;
    const input = this.input;
    let a = input.selectionStart;
    let b = input.selectionEnd;
    const change = session.replaceAll(text);
    input.value = text;
    if (change) {
      a = mapOffset(a, change);
      b = mapOffset(b, change);
    }
    if (document.activeElement === input) input.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
    this.drawCarets();
  }

  /** You typed: share it, then check it (and, if you are the one doing it, put it into the blocks). */
  private typed(): void {
    const session = this.session;
    if (!session?.ready) return;
    const change = diffText(session.text(), this.input.value);
    if (change) session.edit(change);
    this.caretMoved();
    this.afterTextChange();
    this.drawCarets();
  }

  private afterTextChange(): void {
    this.dirty = true;
    this.render();
    this.setStatus('busy', 'Editing…');
    this.scheduleApply();
  }

  private scheduleApply(): void {
    window.clearTimeout(this.applyTimer);
    this.applyTimer = window.setTimeout(() => this.applyNow(), APPLY_DELAY_MS);
  }

  /** Check the text and, if it is valid and this is the computer that does it, put it into the blocks. Returns true when the text is fine. */
  applyNow(): boolean {
    window.clearTimeout(this.applyTimer);
    const source = this.input.value;
    const result = parse(source, { skin: this.skin, externalProcs: this.bridge.externalProcs(this.vm) });
    this.errors = result.errors;
    this.declared = new Set(result.decls.map((d) => d.name));
    this.render();
    this.showErrors();
    if (result.errors.length > 0) {
      const n = result.errors.length;
      const first = result.errors[0];
      this.setStatus('error', `Line ${first.line}: ${first.message.replace(/[.\s]+$/, '')}${n > 1 ? ` (+${n - 1} more)` : ''}. The blocks keep the last working version`);
      return false;
    }
    if (this.session && !this.session.leader) {
      // Somebody else's computer turns the shared text into blocks.
      this.dirty = false;
      this.setStatus('ok', 'Looks good. Shared with others');
      return true;
    }
    const { workspace, Blockly } = this.editor.codeContext();
    this.applying = true;
    try {
      const stats = this.bridge.applyParsed(this.vm, workspace, Blockly, result, this.skin, this.snapshot);
      this.snapshot = { ...stats.snapshot, text: source };
      this.dirty = false;
      const changes = stats.added + stats.removed;
      this.setStatus('ok', changes === 0 ? 'Matches the blocks' : `Blocks updated (${stats.added} added or changed, ${stats.removed} removed)`);
      return true;
    } catch (error) {
      console.error('Could not put the text into the blocks', error);
      logDiag('code', 'apply failed', String(error));
      this.setStatus('error', 'Could not put this into the blocks. Please make a GitHub issue and copy the Diagnostics log.');
      return false;
    } finally {
      this.applying = false;
    }
  }

  private setSkin(skin: Skin): void {
    const session = this.session;
    if (skin === this.skin || !session?.ready) return;
    if (this.dirty && !this.applyNow()) {
      this.setStatus('error', 'Fix the problems before switching style');
      return;
    }
    const converted = convertText(this.input.value, this.skin, skin, this.bridge.externalProcs(this.vm));
    if (!converted.ok) {
      this.errors = converted.errors;
      this.render();
      this.showErrors();
      this.setStatus('error', 'Fix the problems before switching style');
      return;
    }
    this.skin = skin;
    saveCodeSkin(skin);
    this.updateSkinButtons();
    this.bank.setSkin(skin);
    if (session.leader) {
      try {
        this.snapshot = this.bridge.generate(this.vm, skin);
      } catch (error) {
        console.error(error);
      }
    }
    const input = this.input;
    let a = input.selectionStart;
    let b = input.selectionEnd;
    const change = session.switchSkin(skin, converted.text);
    input.value = converted.text;
    if (change) {
      a = mapOffset(a, change);
      b = mapOffset(b, change);
    }
    input.setSelectionRange(Math.min(a, converted.text.length), Math.min(b, converted.text.length));
    this.errors = [];
    this.dirty = false;
    this.render();
    this.showErrors();
    this.drawCarets();
    this.setStatus('ok', 'Matches the blocks');
  }

  // ---- drawing ----

  private setStatus(kind: 'ok' | 'busy' | 'error', text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = kind;
  }

  private tokenize(line: string, state: { comment: boolean }): Piece[] {
    const py = this.skin === 'python';
    const pieces: Piece[] = [];
    const re = py
      ? /(#[^\n]*)|("(?:\\.|[^"\\])*"?)|(`(?:\\.|[^`\\])*`?)|(\d+(?:\.\d+)?|\.\d+)|([\p{L}_][\p{L}\p{N}_]*)|([\s\S])/gu
      : /(\/\/[^\n]*)|("(?:\\.|[^"\\])*"?)|(`(?:\\.|[^`\\])*`?)|(\d+(?:\.\d+)?|\.\d+)|([\p{L}_][\p{L}\p{N}_]*)|([\s\S])/gu;
    let i = 0;
    if (state.comment) {
      const end = line.indexOf('*/');
      if (end < 0) return [{ text: line, cls: 'c' }];
      pieces.push({ text: line.slice(0, end + 2), cls: 'c' });
      i = end + 2;
      state.comment = false;
    }
    re.lastIndex = i;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (!py && m[0] === '/' && line[m.index + 1] === '*') {
        const end = line.indexOf('*/', m.index + 2);
        if (end < 0) {
          pieces.push({ text: line.slice(m.index), cls: 'c' });
          state.comment = true;
          break;
        }
        pieces.push({ text: line.slice(m.index, end + 2), cls: 'c' });
        re.lastIndex = end + 2;
        continue;
      }
      let cls = '';
      if (m[1]) cls = 'c';
      else if (m[2]) cls = 's';
      else if (m[3]) cls = 'v';
      else if (m[4]) cls = 'n';
      else if (m[5]) {
        const word = m[5];
        const after = line.slice(m.index + word.length).trimStart();
        const before = line[m.index - 1];
        if ((before === '[' && !py) || before === '@') cls = 'a';
        else if (KEYWORDS.has(word)) cls = 'k';
        else if (this.declared.has(word)) cls = 'v';
        else if (BLOCK_NAMES.has(word) || after.startsWith('(')) cls = 'f';
      }
      pieces.push({ text: m[0], cls });
    }
    return pieces;
  }

  private render(): void {
    const lines = this.input.value.split('\n');
    const errorsByLine = new Map<number, ParseError[]>();
    for (const e of this.errors) errorsByLine.set(e.line, [...(errorsByLine.get(e.line) ?? []), e]);
    const state = { comment: false };
    const html: string[] = [];
    const numbers: string[] = [];
    lines.forEach((line, index) => {
      const lineNo = index + 1;
      let pieces = this.tokenize(line, state);
      const errs = errorsByLine.get(lineNo);
      if (errs) pieces = this.markErrors(pieces, errs);
      const message = errs ? `<span class="cw-t-msg">${escapeHtml(errs[0].message)}</span>` : '';
      html.push(pieces.map((p) => (p.cls ? `<span class="cw-t-${p.cls.replace(' ', ' cw-t-')}">${escapeHtml(p.text)}</span>` : escapeHtml(p.text))).join('') + message);
      numbers.push(`<div class="${errs ? 'cw-bad' : ''}">${lineNo}</div>`);
    });
    this.highlight.innerHTML = html.join('\n') + '\n';
    this.gutter.innerHTML = numbers.join('');
  }

  /** Underline the characters an error points at. */
  private markErrors(pieces: Piece[], errs: ParseError[]): Piece[] {
    const out: Piece[] = [];
    let pos = 0;
    const bad = (at: number): boolean => errs.some((e) => at >= e.col - 1 && at < e.col - 1 + Math.max(1, e.len));
    for (const piece of pieces) {
      let current: Piece | null = null;
      for (const ch of piece.text) {
        const isBad = bad(pos);
        const cls = isBad ? `${piece.cls} err`.trim() : piece.cls;
        if (current && current.cls === cls) current.text += ch;
        else {
          current = { text: ch, cls };
          out.push(current);
        }
        pos += ch.length;
      }
    }
    // An error at the very end of the line (a missing ;) has no character to underline, so mark a space.
    if (errs.some((e) => e.col - 1 >= pos)) out.push({ text: ' ', cls: 'err' });
    return out;
  }

  private showErrors(): void {
    this.errorsEl.replaceChildren();
    this.errorsEl.hidden = this.errors.length === 0;
    for (const e of this.errors.slice(0, 20)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cw-code-error';
      const where = document.createElement('b');
      where.textContent = `Line ${e.line}`;
      row.append(where, e.message);
      row.addEventListener('click', () => this.jumpTo(e));
      this.errorsEl.appendChild(row);
    }
  }

  private jumpTo(e: ParseError): void {
    const lines = this.input.value.split('\n');
    let offset = 0;
    for (let i = 0; i < e.line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    offset += Math.max(0, e.col - 1);
    this.input.focus();
    this.input.setSelectionRange(offset, offset + Math.max(0, e.len));
  }

  // ---- typing helpers ----

  private keydown(e: KeyboardEvent): void {
    if (this.hints.handleKey(e)) return;
    const input = this.input;
    if (input.readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = input;
      if (a === b && !e.shiftKey) {
        document.execCommand('insertText', false, '\t');
        return;
      }
      // indent or unindent every selected line
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const block = value.slice(lineStart, b);
      const changed = block
        .split('\n')
        .map((l) => (e.shiftKey ? l.replace(/^( {1,4}|\t)/, '') : `\t${l}`))
        .join('\n');
      input.setSelectionRange(lineStart, b);
      document.execCommand('insertText', false, changed);
      input.setSelectionRange(lineStart, lineStart + changed.length);
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const { selectionStart: a, value } = input;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const before = value.slice(lineStart, a);
      const indent = /^[ \t]*/.exec(before)![0];
      const opens = /[{:]\s*$/.test(before);
      const closesNext = this.skin === 'csharp' && opens && before.trimEnd().endsWith('{') && /^[ \t]*\}/.test(value.slice(a));
      e.preventDefault();
      if (closesNext) {
        document.execCommand('insertText', false, `\n${indent}\t\n${indent}`);
        const pos = a + 1 + indent.length + 1;
        input.setSelectionRange(pos, pos);
      } else document.execCommand('insertText', false, `\n${indent}${opens ? '\t' : ''}`);
      return;
    }
    if (e.key === '}' && this.skin === 'csharp') {
      const { selectionStart: a, selectionEnd: b, value } = input;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const before = value.slice(lineStart, a);
      if (a === b && /^[ \t]+$/.test(before)) {
        const remove = before.endsWith('\t') ? 1 : Math.min(4, before.length);
        input.setSelectionRange(a - remove, a);
        document.execCommand('insertText', false, '}');
        e.preventDefault();
      }
    }
  }
}
