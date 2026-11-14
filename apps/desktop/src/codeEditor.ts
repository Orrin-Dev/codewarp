import { BLOCKS, KEYWORDS, type ParseError, type Skin, parse, skinName } from '@codewarp/core';
import type { BlocksEditor } from './blocksEditor';
import { applyParsed, externalProcs, generate, type Snapshot } from './codeBridge';
import { getCodeSkin, saveCodeSkin } from './settings';
import { logDiag } from './diagnostics';
import { CodeHints } from './codeHints';
import { CodeBank } from './codeBank';

const APPLY_DELAY_MS = 450;
const REFRESH_DELAY_MS = 250;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BLOCK_NAMES = new Set<string>();
for (const spec of BLOCKS) for (const skin of ['csharp', 'python'] as Skin[]) BLOCK_NAMES.add(skinName(spec.name, skin));

interface Piece {
  text: string;
  cls: string;
}

/** Text mode: write scripts as C#-style or Python-style code. The text and the blocks stay the same project. */
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

  constructor(
    private readonly host: HTMLElement,
    private readonly vm: any,
    private readonly editor: BlocksEditor,
  ) {
    this.build();
    this.editor.onBlocksChanged(() => this.blocksChanged());
    this.vm.addListener('workspaceUpdate', () => this.targetMaybeChanged());
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
      b.addEventListener('click', () => void this.setSkin(skin));
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
    bar.append(seg, this.statusEl, this.bankButton);

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
    inner.append(this.gutter, this.highlight, this.input);
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
    this.input.addEventListener('blur', () => {
      if (!this.dirty) this.refresh(true);
    });
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
    const re = /^[ \t]*(?:(?:cloud|local|global)[ \t]+)*(var|list)[ \t]+(`[^`\n]+`|[\p{L}_][\p{L}\p{N}_]*)/gmu;
    for (let m = re.exec(this.input.value); m; m = re.exec(this.input.value)) {
      const name = m[2].startsWith('`') ? m[2].slice(1, -1) : m[2];
      out.set(name, m[1] as 'var' | 'list');
    }
    return out;
  }

  /** Put code from the Code Bank at the cursor, on its own line, indented to match. */
  private insertCode(code: string, inline: boolean): void {
    const input = this.input;
    input.focus();
    const { selectionStart: a, value } = input;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    const before = value.slice(lineStart, a);
    const indent = /^ */.exec(before)![0];
    const body = code
      .replace(/^[ ]*\.\.\.[ ]*$/gm, '')
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
    this.refresh(true);
    this.input.focus();
  }

  hide(): void {
    if (!this.shown) return;
    window.clearTimeout(this.applyTimer);
    if (this.dirty) this.applyNow();
    this.shown = false;
    this.root.hidden = true;
  }

  get isShown(): boolean {
    return this.shown;
  }

  // ---- text <-> blocks ----

  /** The blocks changed (by you, or by a collaborator): update the text unless you are in the middle of typing. */
  private blocksChanged(): void {
    if (!this.shown || this.applying) return;
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
    this.refresh(true);
  }

  /** Write the blocks out as text. */
  refresh(force: boolean): void {
    if (!this.shown || this.applying) return;
    if (this.dirty && !force) return;
    if (!this.vm.editingTarget) return;
    let snap: Snapshot;
    try {
      snap = generate(this.vm, this.skin);
    } catch (error) {
      console.error('Could not write the blocks as text', error);
      logDiag('code', 'generate failed', String(error));
      this.setStatus('error', 'Could not turn these blocks into text (see Settings > Diagnostics)');
      return;
    }
    this.snapshot = snap;
    this.dirty = false;
    if (snap.text !== this.input.value) {
      const start = this.input.selectionStart;
      this.input.value = snap.text;
      if (document.activeElement === this.input) this.input.setSelectionRange(Math.min(start, snap.text.length), Math.min(start, snap.text.length));
    }
    this.errors = [];
    this.render();
    this.showErrors();
    this.setStatus('ok', 'Matches the blocks');
  }

  private typed(): void {
    this.dirty = true;
    this.render();
    this.setStatus('busy', 'Editing…');
    window.clearTimeout(this.applyTimer);
    this.applyTimer = window.setTimeout(() => this.applyNow(), APPLY_DELAY_MS);
  }

  /** Check the text and, if it is valid, put it into the blocks. Returns true when the blocks match the text. */
  applyNow(): boolean {
    window.clearTimeout(this.applyTimer);
    const source = this.input.value;
    const result = parse(source, { skin: this.skin, externalProcs: externalProcs(this.vm) });
    this.errors = result.errors;
    this.declared = new Set(result.decls.map((d) => d.name));
    this.render();
    this.showErrors();
    if (result.errors.length > 0) {
      const n = result.errors.length;
      this.setStatus('error', `${n} problem${n === 1 ? '' : 's'}. The blocks keep your last working version`);
      return false;
    }
    const { workspace, Blockly } = this.editor.codeContext();
    this.applying = true;
    try {
      const stats = applyParsed(this.vm, workspace, Blockly, result, this.skin, this.snapshot);
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

  private async setSkin(skin: Skin): Promise<void> {
    if (skin === this.skin) return;
    if (this.dirty && !this.applyNow()) {
      this.setStatus('error', 'Fix the problems before switching style');
      return;
    }
    this.skin = skin;
    saveCodeSkin(skin);
    this.updateSkinButtons();
    this.bank.setSkin(skin);
    this.dirty = false;
    this.refresh(true);
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
        if (KEYWORDS.has(word)) cls = 'k';
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
      html.push(pieces.map((p) => (p.cls ? `<span class="cw-t-${p.cls.replace(' ', ' cw-t-')}">${escapeHtml(p.text)}</span>` : escapeHtml(p.text))).join(''));
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
      row.textContent = `Line ${e.line}: ${e.message}`;
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
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = input;
      if (a === b && !e.shiftKey) {
        document.execCommand('insertText', false, '    ');
        return;
      }
      // indent or unindent every selected line
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const block = value.slice(lineStart, b);
      const changed = block
        .split('\n')
        .map((l) => (e.shiftKey ? l.replace(/^( {1,4}|\t)/, '') : `    ${l}`))
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
      const indent = /^ */.exec(before)![0];
      const opens = /[{:]\s*$/.test(before);
      const closesNext = this.skin === 'csharp' && opens && before.trimEnd().endsWith('{') && value.slice(a).trimStart().startsWith('}') && /^[ \t]*\}/.test(value.slice(a));
      e.preventDefault();
      if (closesNext) {
        document.execCommand('insertText', false, `\n${indent}    \n${indent}`);
        const pos = a + 1 + indent.length + 4;
        input.setSelectionRange(pos, pos);
      } else document.execCommand('insertText', false, `\n${indent}${opens ? '    ' : ''}`);
      return;
    }
    if (e.key === '}' && this.skin === 'csharp') {
      const { selectionStart: a, selectionEnd: b, value } = input;
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const before = value.slice(lineStart, a);
      if (a === b && /^ {4,}$/.test(before)) {
        input.setSelectionRange(a - 4, a);
        document.execCommand('insertText', false, '}');
        e.preventDefault();
      }
    }
  }
}
