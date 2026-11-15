import { TextDoc, type Op, type TextChange, type TextOp, diffText, mapOffset } from '@codewarp/core';

/**
 * Shared typing in the code editor.
 *
 * Everyone who has the code editor open for the same sprite types into one shared document (see textdoc.ts in
 * core), so every letter shows up for the others as it is typed and nobody's edits get lost. Only one of them,
 * the "leader" (the person with the lowest id), turns the text into blocks; everybody else just keeps the text.
 * That is what stops two computers from fighting over the blocks.
 *
 * This file knows nothing about the screen. The Collab class gives the hub a transport to send things with.
 */

export interface TextTransport {
  /** Your id in the room, or null when not in a room. */
  myId(): string | null;
  /** True while edits can be sent. */
  live(): boolean;
  peerIds(): string[];
  peerInfo(id: string): { name: string; color: string } | undefined;
  sendOps(ops: Op[]): void;
  sendCursor(target: string, x: number, y: number): void;
}

export interface RemoteCaret {
  id: string;
  name: string;
  color: string;
  /** Selection start and end (the caret is where `head` is). */
  from: number;
  to: number;
  head: number;
}

export interface SessionEvents {
  /** The text is available (after joining). */
  ready(): void;
  /** Other people's typing changed the text. `from` is who typed. */
  changed(changes: TextChange[], from: string | null): void;
  /** Somebody switched the style. */
  skin(skin: string): void;
  /** You became (or stopped being) the person who turns text into blocks. */
  leader(isLeader: boolean): void;
  /** Where other people's cursors are changed. */
  carets(): void;
}

const JOIN_WAIT_MS = 700;
const JOIN_WAIT_LONG_MS = 1800;
const CARET_EVERY_MS = 50;
const CARET_HEARTBEAT_MS = 3000;
const CARET_EXPIRE_MS = 9000;
const CHECK_EVERY_MS = 6000;
const MAX_TARGET_NAME = 60;

interface Caret {
  from: number;
  to: number;
  head: number;
  seen: number;
}

const checksum = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

const randomSite = (): string => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export class TextSession {
  doc: TextDoc;
  skin: string;
  ready = false;
  leader = true;

  private readonly carets = new Map<string, Caret>();
  private readonly participants = new Set<string>();
  /** People who asked for the text while we had none; they get it when it is ready. */
  private readonly askers = new Set<string>();
  private queued: { from: string; op: Op }[] = [];
  private joinTimer: number | undefined;
  private caretTimer: number | undefined;
  private lastCaretSent = 0;
  private myCaret = { from: 0, to: 0, head: 0 };
  private closed = false;
  private lastCheck = 0;

  constructor(
    readonly hub: TextHub,
    readonly sprite: string,
    skin: string,
    private readonly seed: () => string,
    private readonly events: SessionEvents,
  ) {
    this.doc = new TextDoc(randomSite());
    this.skin = skin;
  }

  /** What other people's cursor messages name this editor by (the server cuts names at 80 characters). */
  get target(): string {
    return `@text:${this.sprite.slice(0, MAX_TARGET_NAME)}`;
  }

  text(): string {
    return this.doc.text();
  }

  // ---- joining ---------------------------------------------------------------------------

  /** Ask the others for the text, or start it from `seed` when nobody has it. */
  start(): void {
    const t = this.hub.transport;
    const others = t?.live() ? t.peerIds() : [];
    if (!t || others.length === 0) {
      this.becomeReady(this.seed());
      return;
    }
    t.sendOps([{ k: 'text-join', sprite: this.sprite }]);
    this.joinTimer = window.setTimeout(() => this.joinTimedOut(), JOIN_WAIT_MS);
  }

  private joinTimedOut(): void {
    if (this.ready || this.closed) return;
    const t = this.hub.transport;
    const me = t?.myId() ?? '';
    // Someone with a lower id who is also joining will have the text started in a moment: wait for it.
    const lower = [...this.participants].some((id) => id < me);
    if (lower && !this.extended) {
      this.extended = true;
      this.joinTimer = window.setTimeout(() => this.joinTimedOut(), JOIN_WAIT_LONG_MS - JOIN_WAIT_MS);
      return;
    }
    this.becomeReady(this.seed());
  }
  private extended = false;

  private becomeReady(initial: string | null): void {
    window.clearTimeout(this.joinTimer);
    if (this.ready || this.closed) return;
    if (initial !== null && this.doc.length === 0 && initial.length > 0) {
      // The first characters have an id made from their own text: if two people start the same text at the
      // same moment, they get the same characters and the copies merge into one instead of doubling.
      const seeded = new TextDoc(`~${checksum(initial).toString(36)}`);
      seeded.insert(0, initial);
      this.doc.merge(seeded.state());
    }
    this.ready = true;
    this.updateLeader();
    this.events.ready();
    const queued = this.queued;
    this.queued = [];
    for (const { from, op } of queued) this.receive(from, op);
    for (const id of this.askers) this.sendState(id);
    this.askers.clear();
    this.startTimers();
    if (this.participants.size > 0) this.sendCaretNow();
  }

  private startTimers(): void {
    window.clearInterval(this.caretTimer);
    this.caretTimer = window.setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const now = performance.now();
    let changed = false;
    for (const [id, c] of this.carets) {
      if (now - c.seen > CARET_EXPIRE_MS) {
        this.carets.delete(id);
        this.participants.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.updateLeader();
      this.events.carets();
    }
    // Keep our cursor alive for the others, and check we still agree with them.
    const t = this.hub.transport;
    if (t?.live() && this.participants.size > 0) {
      if (now - this.lastCaretSent > CARET_HEARTBEAT_MS) this.sendCaretNow();
      if (now - this.lastCheck > CHECK_EVERY_MS) {
        this.lastCheck = now;
        const text = this.doc.text();
        t.sendOps([{ k: 'text-sum', sprite: this.sprite, sum: checksum(text), length: text.length }]);
      }
    }
  }

  /** The room connection went away: forget who was here. */
  offline(): void {
    this.participants.clear();
    this.carets.clear();
    this.askers.clear();
    this.updateLeader();
    this.events.carets();
  }

  /** The connection came back (or we joined a room): get in step with whoever else has the text open. */
  resync(): void {
    const t = this.hub.transport;
    if (!this.ready || !t?.live()) return;
    t.sendOps([{ k: 'text-join', sprite: this.sprite }, this.stateOp('*')]);
  }

  // ---- our own typing --------------------------------------------------------------------

  /** The text box changed: `change` says how. Returns false while the text is still being fetched. */
  edit(change: TextChange): boolean {
    if (!this.ready) return false;
    const ops: TextOp[] = [];
    const del = this.doc.remove(change.pos, change.del);
    if (del) ops.push(del);
    const ins = this.doc.insert(change.pos, change.ins);
    if (ins) ops.push(ins);
    this.shiftCarets(change, null);
    this.send(ops);
    return true;
  }

  /** Replace everything by `text` (used when the style is switched), sending only what differs. */
  replaceAll(text: string): TextChange | null {
    const change = diffText(this.doc.text(), text);
    if (change) this.edit(change);
    return change;
  }

  /** Switch the style for everyone (the text has been converted already). */
  switchSkin(skin: string, text: string): TextChange | null {
    this.skin = skin;
    this.hub.transport?.sendOps([{ k: 'text-skin', sprite: this.sprite, skin }]);
    return this.replaceAll(text);
  }

  private send(ops: TextOp[]): void {
    if (ops.length === 0) return;
    this.hub.transport?.sendOps([{ k: 'text', sprite: this.sprite, ops }]);
  }

  // ---- other people ------------------------------------------------------------------------

  receive(from: string, op: Op): void {
    if (this.closed) return;
    switch (op.k) {
      case 'text-join':
        this.participants.add(from);
        if (this.ready) {
          this.sendState(from);
          this.sendCaretNow();
        } else this.askers.add(from);
        this.updateLeader();
        break;
      case 'text-state': {
        if (op.to !== '*' && op.to !== this.hub.transport?.myId()) break;
        this.participants.add(from);
        if (!this.ready) {
          this.doc.merge(op.runs);
          this.skin = op.skin;
          this.events.skin(op.skin);
          this.becomeReady(null);
          break;
        }
        const before = this.doc.text();
        if (this.doc.merge(op.runs)) {
          const change = diffText(before, this.doc.text());
          if (change) {
            this.shiftCarets(change, from);
            this.events.changed([change], from);
          }
        }
        this.updateLeader();
        break;
      }
      case 'text': {
        this.participants.add(from);
        if (!this.ready) {
          this.queued.push({ from, op });
          break;
        }
        const changes: TextChange[] = [];
        for (const o of op.ops) changes.push(...this.doc.apply(o));
        if (changes.length) {
          for (const c of changes) this.shiftCarets(c, from);
          this.events.changed(changes, from);
          this.events.carets();
        }
        this.updateLeader();
        break;
      }
      case 'text-skin':
        this.participants.add(from);
        if (!this.ready) {
          this.queued.push({ from, op });
          break;
        }
        this.skin = op.skin;
        this.events.skin(op.skin);
        break;
      case 'text-leave':
        this.participants.delete(from);
        this.carets.delete(from);
        this.updateLeader();
        this.events.carets();
        break;
      case 'text-sum': {
        this.participants.add(from);
        if (!this.ready) break;
        const text = this.doc.text();
        if (op.sum === checksum(text) && op.length === text.length) break;
        // We differ. Give it a moment (the other edit may be on its way), then compare again by swapping copies.
        const length = text.length;
        window.setTimeout(() => {
          if (this.closed || this.doc.length !== length) return;
          this.resync();
        }, 1500);
        break;
      }
    }
  }

  /** `from`'s caret. */
  setRemoteCaret(from: string, a: number, b: number): void {
    this.participants.add(from);
    const len = this.doc.length;
    const clamp = (n: number): number => Math.max(0, Math.min(len, Math.round(n)));
    const lo = clamp(Math.min(a, b));
    const hi = clamp(Math.max(a, b));
    // y is the end of the selection and x the start, and the caret sits at y: head = b
    this.carets.set(from, { from: lo, to: hi, head: clamp(b), seen: performance.now() });
    this.updateLeader();
    this.events.carets();
  }

  removeRemoteCaret(from: string): void {
    if (this.carets.delete(from)) this.events.carets();
  }

  peerLeft(id: string): void {
    this.participants.delete(id);
    this.askers.delete(id);
    this.carets.delete(id);
    this.updateLeader();
    this.events.carets();
  }

  remoteCarets(): RemoteCaret[] {
    const t = this.hub.transport;
    const out: RemoteCaret[] = [];
    for (const [id, c] of this.carets) {
      const info = t?.peerInfo(id);
      if (!info) continue;
      out.push({ id, name: info.name, color: info.color, from: c.from, to: c.to, head: c.head });
    }
    return out;
  }

  get others(): number {
    return this.participants.size;
  }

  /** Everyone else who has this sprite's code editor open. */
  people(): { id: string; name: string; color: string }[] {
    const t = this.hub.transport;
    const out: { id: string; name: string; color: string }[] = [];
    for (const id of this.participants) {
      const info = t?.peerInfo(id);
      if (info) out.push({ id, ...info });
    }
    return out;
  }

  // ---- our own cursor -------------------------------------------------------------------------

  /** Tell the others where our cursor is (limited to a few times a second). */
  setCaret(from: number, to: number, head: number): void {
    this.myCaret = { from, to, head };
    const t = this.hub.transport;
    if (!t?.live() || this.participants.size === 0) return;
    const wait = CARET_EVERY_MS - (performance.now() - this.lastCaretSent);
    if (wait <= 0) this.sendCaretNow();
    else if (this.caretSendTimer === undefined) {
      this.caretSendTimer = window.setTimeout(() => {
        this.caretSendTimer = undefined;
        this.sendCaretNow();
      }, wait);
    }
  }
  private caretSendTimer: number | undefined;

  private sendCaretNow(): void {
    this.lastCaretSent = performance.now();
    const t = this.hub.transport;
    if (!t?.live()) return;
    const { from, to, head } = this.myCaret;
    // x and y are the two ends; the caret is at y, so put the head last.
    const [x, y] = head === to ? [from, to] : [to, from];
    t.sendCursor(this.target, x, y);
  }

  // ---- bookkeeping -------------------------------------------------------------------------------

  private stateOp(to: string): Op {
    return { k: 'text-state', sprite: this.sprite, to, skin: this.skin, runs: this.doc.state() };
  }

  private sendState(to: string): void {
    this.hub.transport?.sendOps([this.stateOp(to)]);
  }

  /** The text moved: other people's cursors move with it. `from` is who typed (their own cursor ends after it). */
  private shiftCarets(change: TextChange, from: string | null): void {
    for (const [id, c] of this.carets) {
      if (id === from) {
        const at = change.pos + change.ins.length;
        c.from = c.to = c.head = at;
        c.seen = performance.now();
        continue;
      }
      c.from = mapOffset(c.from, change);
      c.to = mapOffset(c.to, change);
      c.head = mapOffset(c.head, change);
    }
  }

  private updateLeader(): void {
    const me = this.hub.transport?.myId();
    let leader = true;
    if (me) for (const id of this.participants) if (id < me) leader = false;
    if (leader !== this.leader) {
      this.leader = leader;
      if (this.ready) this.events.leader(leader);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.joinTimer);
    window.clearTimeout(this.caretSendTimer);
    window.clearInterval(this.caretTimer);
    if (this.ready) this.hub.transport?.sendOps([{ k: 'text-leave', sprite: this.sprite }]);
    this.hub.forget(this);
  }
}

/** All the shared code editors this computer has open (one per sprite), and the link to the room. */
export class TextHub {
  transport: TextTransport | null = null;
  private readonly sessions = new Map<string, TextSession>();

  /** Make the session for `sprite`; call start() on it once it is stored (it may finish at once). */
  open(sprite: string, skin: string, seed: () => string, events: SessionEvents): TextSession {
    this.sessions.get(sprite)?.close();
    const session = new TextSession(this, sprite, skin, seed, events);
    this.sessions.set(sprite, session);
    return session;
  }

  forget(session: TextSession): void {
    if (this.sessions.get(session.sprite) === session) this.sessions.delete(session.sprite);
  }

  /** The room connection is ready (or came back). */
  attach(transport: TextTransport): void {
    this.transport = transport;
    for (const s of this.sessions.values()) s.resync();
  }

  /** The room connection went away. Open editors keep working on their own. */
  detach(): void {
    this.transport = null;
    for (const s of this.sessions.values()) s.offline();
  }

  receive(from: string, op: Op): void {
    const sprite = (op as { sprite?: string }).sprite;
    if (sprite === undefined) return;
    this.sessions.get(sprite)?.receive(from, op);
  }

  cursor(from: string, target: string, x: number, y: number): void {
    if (target === '@textoff') {
      for (const s of this.sessions.values()) s.removeRemoteCaret(from);
      return;
    }
    for (const s of this.sessions.values()) {
      if (s.target === target) s.setRemoteCaret(from, x, y);
      else s.removeRemoteCaret(from);
    }
  }

  peerLeft(id: string): void {
    for (const s of this.sessions.values()) s.peerLeft(id);
  }
}
