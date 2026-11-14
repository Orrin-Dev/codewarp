import { BASICS, CATEGORIES, type Doc, type Skin, allDocs } from '@codewarp/core';

const COLORS: Record<string, string> = {
  Motion: '#4C97FF',
  Looks: '#9966FF',
  Sound: '#CF63CF',
  Events: '#FFBF00',
  Control: '#FFAB19',
  Sensing: '#5CB1D6',
  Operators: '#59C059',
  Variables: '#FF8C1A',
  'My Blocks': '#FF6680',
};

const KIND_NAMES: Record<Doc['kind'], string> = {
  statement: 'statement',
  value: 'gives a value',
  condition: 'true / false',
  event: 'starts a script',
  other: 'structure',
};

/**
 * The Code Bank: every piece of the syntax, what it does, and which Scratch block it is. Entries can be
 * inserted into the code or copied.
 */
export class CodeBank {
  readonly element = document.createElement('aside');
  private readonly list = document.createElement('div');
  private readonly search = document.createElement('input');
  private readonly docs = allDocs();
  private skin: Skin = 'csharp';

  constructor(private readonly onInsert: (code: string, inline: boolean) => void) {
    this.element.className = 'cw-bank';
    this.element.hidden = true;
    const head = document.createElement('div');
    head.className = 'cw-bank-head';
    const title = document.createElement('strong');
    title.textContent = 'Code bank';
    const hint = document.createElement('span');
    hint.textContent = 'Every block as code';
    head.append(title, hint);
    this.search.type = 'search';
    this.search.placeholder = 'Search blocks, e.g. "say" or "go to"';
    this.search.className = 'cw-bank-search';
    this.search.addEventListener('input', () => this.render());
    this.list.className = 'cw-bank-list';
    this.element.append(head, this.search, this.list);
    this.render();
  }

  setSkin(skin: Skin): void {
    this.skin = skin;
    this.render();
  }

  toggle(): boolean {
    this.element.hidden = !this.element.hidden;
    if (!this.element.hidden) this.search.focus();
    return !this.element.hidden;
  }

  get shown(): boolean {
    return !this.element.hidden;
  }

  private other(): Skin {
    return this.skin === 'csharp' ? 'python' : 'csharp';
  }

  private codeBlock(code: string, label?: string): HTMLElement {
    const pre = document.createElement('pre');
    pre.className = 'cw-bank-code';
    pre.textContent = code;
    if (label) pre.dataset.label = label;
    return pre;
  }

  private button(text: string, action: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', action);
    return b;
  }

  private entry(doc: Doc): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cw-bank-entry';
    const chip = document.createElement('div');
    chip.className = 'cw-bank-chip';
    chip.style.setProperty('--chip', COLORS[doc.category] ?? '#888');
    chip.textContent = doc.label || doc.op;
    chip.title = `Scratch block: ${doc.op}`;
    const kind = document.createElement('span');
    kind.className = 'cw-bank-kind';
    kind.textContent = KIND_NAMES[doc.kind];
    const desc = document.createElement('p');
    desc.textContent = doc.desc;
    const code = this.codeBlock(this.skin === 'csharp' ? doc.csharp : doc.python);
    const actions = document.createElement('div');
    actions.className = 'cw-bank-actions';
    const exampleNow = (): string => (this.skin === 'csharp' ? doc.csharp : doc.python);
    actions.append(
      this.button('Insert', () => this.onInsert(exampleNow(), doc.kind === 'value' || doc.kind === 'condition')),
      this.button('Copy', () => void navigator.clipboard?.writeText(exampleNow())),
    );
    const alt = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${this.other() === 'csharp' ? 'C#' : 'Python'} version`;
    alt.append(summary, this.codeBlock(this.other() === 'csharp' ? doc.csharp : doc.python));
    card.append(chip, kind, desc, code, actions, alt);
    return card;
  }

  private section(title: string, color: string, entries: HTMLElement[], open: boolean): HTMLElement {
    const details = document.createElement('details');
    details.className = 'cw-bank-section';
    details.open = open;
    details.style.setProperty('--chip', color);
    const summary = document.createElement('summary');
    summary.textContent = `${title} (${entries.length})`;
    details.append(summary, ...entries);
    return details;
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const open = query !== '';
    const parts: HTMLElement[] = [];
    const matches = (...texts: string[]): boolean => !query || texts.some((t) => t.toLowerCase().includes(query));

    const basics = BASICS.filter((b) => matches(b.title, b.desc, b.csharp, b.python)).map((b) => {
      const card = document.createElement('div');
      card.className = 'cw-bank-entry cw-bank-basic';
      const h = document.createElement('div');
      h.className = 'cw-bank-title';
      h.textContent = b.title;
      const p = document.createElement('p');
      p.textContent = b.desc;
      const code = this.codeBlock(this.skin === 'csharp' ? b.csharp : b.python);
      const actions = document.createElement('div');
      actions.className = 'cw-bank-actions';
      actions.append(this.button('Insert', () => this.onInsert(this.skin === 'csharp' ? b.csharp : b.python, false)));
      card.append(h, p, code, actions);
      return card;
    });
    if (basics.length > 0) parts.push(this.section('The basics', '#6d7cff', basics, !query || open));

    for (const category of CATEGORIES) {
      const entries = this.docs
        .filter((d) => d.category === category && matches(d.label, d.desc, d.csharp, d.python, d.op))
        .map((d) => this.entry(d));
      if (entries.length > 0) parts.push(this.section(category, COLORS[category] ?? '#888', entries, open));
    }
    if (parts.length === 0) {
      const none = document.createElement('p');
      none.className = 'cw-bank-none';
      none.textContent = 'Nothing matches that.';
      parts.push(none);
    }
    this.list.replaceChildren(...parts);
  }
}
