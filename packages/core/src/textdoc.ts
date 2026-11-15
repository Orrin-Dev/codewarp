/**
 * A shared text document that any number of people can type in at once and always end up with the same text.
 *
 * Every character gets a permanent id (a counter plus the id of the person who typed it) and remembers which
 * character it was typed after. That is all the information needed to put a character in the same place on
 * every computer, whatever order the edits arrive in (this is the "RGA" kind of CRDT). Deleted characters stay
 * behind as invisible markers so later edits still know where they belong.
 *
 * Typing is sent as runs (a string of characters with consecutive ids), so pasting a page is one operation.
 */

/** Id of one character: [person, counter]. */
export type CharId = [string, number];

export type TextOp =
  /** `x` was typed after the character `a` (null = at the very start). Character k of x has counter c + k. */
  | { t: 'i'; s: string; c: number; a: CharId | null; x: string }
  /** Delete runs of characters: [person, first counter, how many]. */
  | { t: 'd'; r: [string, number, number][] };

/** One run of the whole document, in order (used to hand the document to someone who just joined). */
export interface TextRun {
  s: string;
  c: number;
  /** What the first character of the run was typed after. The others follow each other. */
  a: CharId | null;
  x: string;
  /** Deleted? */
  d?: 1;
}

/** A change to the visible text: at `pos`, `del` characters were removed and `ins` was put there. */
export interface TextChange {
  pos: number;
  del: number;
  ins: string;
}

interface Node {
  s: string;
  c: number;
  ch: string;
  del: boolean;
  /** The node this one was typed after. */
  o: Node | null;
}

const key = (s: string, c: number): string => `${c}@${s}`;
const greater = (a: Node | { s: string; c: number }, b: { s: string; c: number }): boolean => a.c > b.c || (a.c === b.c && a.s > b.s);

export class TextDoc {
  private arr: Node[] = [];
  private readonly byId = new Map<string, Node>();
  private clock = 0;
  private pending: TextOp[] = [];
  private visible = 0;

  constructor(readonly site: string) {}

  get length(): number {
    return this.visible;
  }

  text(): string {
    let out = '';
    for (const n of this.arr) if (!n.del) out += n.ch;
    return out;
  }

  // ---- local edits ---------------------------------------------------------------------

  /** Type `text` at visible position `pos`. Returns the operation to send. */
  insert(pos: number, text: string): TextOp | null {
    if (!text) return null;
    pos = Math.max(0, Math.min(pos, this.visible));
    let origin: Node | null = null;
    if (pos > 0) {
      let seen = 0;
      for (const n of this.arr) {
        if (n.del) continue;
        if (++seen === pos) {
          origin = n;
          break;
        }
      }
    }
    const c = this.clock + 1;
    const op: TextOp = { t: 'i', s: this.site, c, a: origin ? [origin.s, origin.c] : null, x: text };
    this.integrate(op);
    return op;
  }

  /** Delete `len` characters from visible position `pos`. Returns the operation to send. */
  remove(pos: number, len: number): TextOp | null {
    pos = Math.max(0, pos);
    len = Math.min(len, this.visible - pos);
    if (len <= 0) return null;
    const runs: [string, number, number][] = [];
    let seen = 0;
    for (const n of this.arr) {
      if (n.del) continue;
      if (seen >= pos + len) break;
      if (seen >= pos) {
        n.del = true;
        this.visible--;
        const last = runs[runs.length - 1];
        if (last && last[0] === n.s && last[1] + last[2] === n.c) last[2]++;
        else runs.push([n.s, n.c, 1]);
      }
      seen++;
    }
    // `seen` counted visible nodes before they were hidden, which is what pos and len mean.
    return { t: 'd', r: runs };
  }

  /** Change the whole text to `next` by editing only the part that differs. */
  replaceAll(next: string): TextOp[] {
    const now = this.text();
    const change = diffText(now, next);
    if (!change) return [];
    const ops: TextOp[] = [];
    const del = this.remove(change.pos, change.del);
    if (del) ops.push(del);
    const ins = this.insert(change.pos, change.ins);
    if (ins) ops.push(ins);
    return ops;
  }

  // ---- other people's edits -----------------------------------------------------------

  /**
   * Apply an operation (from anyone, in any order, any number of times). Returns how the visible text changed,
   * as changes to apply one after the other.
   */
  apply(op: TextOp): TextChange[] {
    const changes: TextChange[] = [];
    if (!this.tryApply(op, changes)) {
      if (this.pending.length < 5000) this.pending.push(op); // waiting for something that has not arrived yet
      return changes;
    }
    // Anything that was waiting may be able to go now.
    let progress = this.pending.length > 0;
    while (progress) {
      progress = false;
      const waiting = this.pending;
      this.pending = [];
      for (const p of waiting) {
        if (this.tryApply(p, changes)) progress = true;
        else this.pending.push(p);
      }
    }
    return changes;
  }

  private tryApply(op: TextOp, changes: TextChange[]): boolean {
    if (op.t === 'i') {
      if (op.a && !this.byId.get(key(op.a[0], op.a[1]))) return false;
      this.integrate(op, changes);
      return true;
    }
    const targets: Node[] = [];
    for (const [s, c, len] of op.r) {
      for (let k = 0; k < len; k++) {
        const n = this.byId.get(key(s, c + k));
        if (!n) return false;
        targets.push(n);
      }
    }
    this.hide(targets, changes);
    return true;
  }

  private hide(targets: Node[], changes?: TextChange[]): void {
    const hit = new Set(targets.filter((n) => !n.del));
    if (hit.size === 0) return;
    let pos = 0;
    let last: TextChange | null = null;
    for (const n of this.arr) {
      if (n.del) continue;
      if (hit.has(n)) {
        n.del = true;
        this.visible--;
        if (last && last.pos === pos) last.del++;
        else {
          last = { pos, del: 1, ins: '' };
          changes?.push(last);
        }
      } else {
        pos++;
        last = null;
      }
    }
  }

  private integrate(op: Extract<TextOp, { t: 'i' }>, changes?: TextChange[]): void {
    const origin = op.a ? this.byId.get(key(op.a[0], op.a[1])) ?? null : null;
    let prev: Node | null = origin;
    let at = -1; // index of prev in arr
    let vis = 0; // visible characters before the place the next character goes
    let known = false;
    let piece: TextChange | null = null;
    for (let k = 0; k < op.x.length; k++) {
      const id = { s: op.s, c: op.c + k };
      this.clock = Math.max(this.clock, id.c);
      const existing = this.byId.get(key(id.s, id.c));
      if (existing) {
        // Already here (the same edit arrived twice, or came inside a copy of the document).
        prev = existing;
        known = false;
        piece = null;
        continue;
      }
      if (!known) {
        at = prev ? this.arr.indexOf(prev) : -1;
        vis = 0;
        for (let i = 0; i <= at; i++) if (!this.arr[i].del) vis++;
        known = true;
      }
      let i = at + 1;
      while (i < this.arr.length && greater(this.arr[i], id)) {
        if (!this.arr[i].del) vis++;
        i++;
      }
      const node: Node = { s: id.s, c: id.c, ch: op.x[k], del: false, o: prev };
      this.arr.splice(i, 0, node);
      this.byId.set(key(id.s, id.c), node);
      this.visible++;
      if (changes) {
        if (piece && piece.pos + piece.ins.length === vis) piece.ins += node.ch;
        else {
          piece = { pos: vis, del: 0, ins: node.ch };
          changes.push(piece);
        }
      }
      vis++;
      prev = node;
      at = i;
    }
  }

  // ---- handing the document to someone ------------------------------------------------

  /** The whole document, in order, as runs. */
  state(): TextRun[] {
    const runs: TextRun[] = [];
    let cur: TextRun | null = null;
    let last: Node | null = null;
    for (const n of this.arr) {
      if (cur && last && n.s === last.s && n.c === last.c + 1 && n.o === last && n.del === last.del) {
        cur.x += n.ch;
      } else {
        cur = { s: n.s, c: n.c, a: n.o ? [n.o.s, n.o.c] : null, x: n.ch };
        if (n.del) cur.d = 1;
        runs.push(cur);
      }
      last = n;
    }
    return runs;
  }

  /** Take in a copy of someone's document (it merges with what is here). Returns true when the text changed. */
  merge(runs: TextRun[]): boolean {
    const before = this.visible;
    const beforeText = this.text();
    for (const run of runs) {
      this.integrate({ t: 'i', s: run.s, c: run.c, a: run.a, x: run.x });
    }
    const hide: Node[] = [];
    for (const run of runs) {
      if (!run.d) continue;
      for (let k = 0; k < run.x.length; k++) {
        const n = this.byId.get(key(run.s, run.c + k));
        if (n) hide.push(n);
      }
    }
    this.hide(hide);
    // Anything that was waiting on this copy.
    const queued = this.pending;
    this.pending = [];
    for (const op of queued) this.apply(op);
    return before !== this.visible || beforeText !== this.text();
  }
}

/** The smallest single edit that turns `a` into `b`, or null when they are the same. */
export function diffText(a: string, b: string): TextChange | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { pos: start, del: endA - start, ins: b.slice(start, endB) };
}

/** Where a caret at `offset` ends up after `change`. */
export function mapOffset(offset: number, change: TextChange, stickToInsert = false): number {
  if (offset < change.pos || (offset === change.pos && !stickToInsert)) return offset;
  if (offset >= change.pos + change.del) return offset - change.del + change.ins.length;
  return change.pos + change.ins.length; // it was inside what got deleted
}
