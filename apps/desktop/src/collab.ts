import { logDiag } from './diagnostics';
import { MAX_SNAPSHOT_CHUNKS, SNAPSHOT_CHUNK_BYTES } from '@codewarp/core';
import type { ClientMessage, MonitorState, Op, Peer, ServerMessage } from '@codewarp/core';
import type { VmHost } from './vmHost';
import type { BlocksEditor, LocalEdit } from './blocksEditor';
import { StateSync, fromBase64, toBase64 } from './stateSync';
import { LiveRun } from './liveRun';
import { collabServerUrl } from './collabConfig';
import { compareDigests } from './syncModel';

export type CollabState = 'offline' | 'connecting' | 'syncing' | 'live' | 'reconnecting';

export interface CollabEvents {
  /** Connection state, people in the room, host or who is running a test changed. */
  onChange: () => void;
  /** Something the user should know about (shown in the status bar). */
  onMessage: (text: string) => void;
}

interface RemoteCursor {
  el: HTMLElement;
  /** Which sprite's workspace the mouse is over (the last one, if it is somewhere else in the app now). */
  target: string;
  /** 'workspace': over the blocks, x and y are workspace units. 'window': anywhere else, x and y are fractions of the window. */
  kind: 'workspace' | 'window';
  /** Where the other person's mouse is, in workspace coordinates. */
  x: number;
  y: number;
  /** Where the cursor is drawn right now; it glides towards x, y. */
  dx: number;
  dy: number;
  seen: number;
}

const CURSOR_TIMEOUT_MS = 8000;
const CURSOR_GLIDE = 0.45;
/** How long to wait for the host to start sending (it has to pack the project first)... */
const SNAPSHOT_TIMEOUT_MS = 60000;
/** ...and how long a started transfer may stall before giving up. */
const SNAPSHOT_IDLE_MS = 30000;
const SEND_BUFFER_LIMIT = 4 * 1024 * 1024;
const HEARTBEAT_MS = 12000;
const DEAD_AFTER_MS = 35000;
const DIGEST_EVERY_MS = 8000;
const QUIET_MS = 1500;
const GIVE_UP_RECONNECT_MS = 5 * 60 * 1000;
const STRIKES_BEFORE_REPAIR = 2;
const MAX_REPAIRS_PER_MINUTE = 3;
const FLUSH_MS = 30;

/**
 * Real-time collaboration client.
 *
 * - Block edits go out as they happen and other people's edits are applied (see BlocksEditor).
 * - Everything else (sprites, costumes, sounds, positions, monitors) is synced by StateSync.
 * - The room host's project is copied to anyone who joins.
 * - The host regularly sends a fingerprint of the project. If yours differs twice in a row, the
 *   differing sprites are replaced with the host's copy, so mistakes fix themselves.
 * - Test runs are streamed: the person who presses Run runs the project and everyone else watches.
 * - If the connection drops it reconnects by itself.
 */
export class Collab {
  state: CollabState = 'offline';
  me: Peer | null = null;
  hostId = '';
  runnerId = '';
  readonly peers = new Map<string, Peer>();

  private readonly stateSync: StateSync;
  private readonly liveRun: LiveRun;

  private ws: WebSocket | null = null;
  private session: { room: string; name: string } | null = null;
  private manualClose = false;
  private reconnectTimer: number | undefined;
  private reconnectAttempts = 0;
  private lostAt = 0;

  private lastSeq = 0;
  private lastHeard = 0;
  private lastActivity = 0;
  private queue: Op[] = [];
  private flushTimer: number | undefined;
  private buffered: { seq: number; ops: Op[] }[] = [];
  private snapshotTimer: number | undefined;
  private incoming: { id: string; total: number; parts: Uint8Array[]; got: number; shown: number } | null = null;
  private heartbeatTimer: number | undefined;
  private digestTimer: number | undefined;
  private stopEdits: (() => void) | null = null;

  private readonly strikes = new Map<string, number>();
  private readonly repairs = new Map<string, number[]>();

  private pendingRun = false;
  private sawRunStart = false;
  private ending = false;
  private runCheckTimer: number | undefined;

  private readonly cursors = new Map<string, RemoteCursor>();
  private readonly cursorLayer = document.createElement('div');
  /** Cursors that are not over the blocks are drawn here, on top of the whole app. */
  private readonly windowLayer = document.createElement('div');
  private cursorFrame = 0;
  private lastCursorSent = 0;
  private cursorHidden = false;
  private stopPresence: (() => void) | null = null;
  private readonly pointerHandler = (e: PointerEvent) => this.sendCursor(e);
  private readonly leaveHandler = () => this.hideMyCursor();
  private readonly mouseOutHandler = (e: MouseEvent) => {
    if (!e.relatedTarget) this.hideMyCursor(); // the mouse left the app window
  };

  constructor(
    private readonly vmHost: VmHost,
    private readonly editor: BlocksEditor,
    private readonly events: CollabEvents,
    stageWrap: HTMLElement,
  ) {
    this.cursorLayer.className = 'cw-cursors';
    editor.element.appendChild(this.cursorLayer);
    this.windowLayer.className = 'cw-cursors cw-cursors-window';
    document.body.appendChild(this.windowLayer);

    this.stateSync = new StateSync(vmHost, (op) => this.enqueue(op));
    this.stateSync.onActivity = () => this.touch();
    this.stateSync.onProblem = (message) => {
      console.warn(message);
      this.strikes.set('@all', STRIKES_BEFORE_REPAIR - 1); // the next fingerprint check will repair
    };
    this.stateSync.blocksHandler = (op) => this.editor.applyRemoteEdit({ target: op.target, event: op.event });

    this.liveRun = new LiveRun(
      vmHost,
      stageWrap,
      (extra) => (this.ws?.readyState === WebSocket.OPEN ? this.ws.bufferedAmount + extra < LiveRun.maxBuffered : false),
      (frame) => this.ws?.send(frame),
    );

    this.vm.addListener('PROJECT_RUN_START', () => {
      this.sawRunStart = true;
    });
    this.vm.addListener('PROJECT_RUN_STOP', () => {
      if (this.isRunner) void this.endRun(false);
    });
  }

  private get vm(): any {
    return this.vmHost.vm;
  }

  get isHost(): boolean {
    return this.me !== null && this.hostId === this.me.id;
  }

  get isRunner(): boolean {
    return this.me !== null && this.runnerId === this.me.id;
  }

  get viewingRun(): boolean {
    return this.runnerId !== '' && !this.isRunner;
  }

  // ---- connecting -------------------------------------------------------------

  connect(room: string, name: string): Promise<void> {
    this.disconnect();
    this.session = { room, name };
    this.manualClose = false;
    this.setState('connecting');
    return this.open(true);
  }

  private open(initial: boolean): Promise<void> {
    const url = collabServerUrl();
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        if (initial) this.setState('offline');
        reject(new Error('The server address is not valid'));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        if (this.ws === ws) this.ws = null;
        ws.close();
        if (initial) this.setState('offline');
        reject(new Error(message));
      };

      ws.addEventListener('open', () => {
        if (this.session) this.send({ t: 'join', room: this.session.room, name: this.session.name });
      });
      ws.addEventListener('error', () => {
        const hint = url.includes('collab.example.com') ? ' (set your server address in packages/core/src/config.ts)' : '';
        fail(`Could not reach the collaboration server${hint}`);
      });
      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        if (!settled) return fail('The server closed the connection');
        logDiag('net', 'connection lost at seq', this.lastSeq);
        this.connectionLost();
      });
      ws.addEventListener('message', (e) => {
        this.lastHeard = Date.now();
        if (typeof e.data !== 'string') {
          if (this.state === 'live') void this.liveRun.showFrame(e.data as ArrayBuffer);
          return;
        }
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'error' && !settled) return fail(msg.message);
        if (msg.t === 'welcome' && !settled) {
          settled = true;
          resolve();
        }
        this.handle(msg);
      });
    });
  }

  /** Leave the room for good. */
  disconnect(): void {
    this.manualClose = true;
    window.clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    this.teardown();
    this.peers.clear();
    this.me = null;
    this.hostId = '';
    this.runnerId = '';
    this.session = null;
    this.setState('offline');
  }

  private connectionLost(): void {
    if (this.manualClose || !this.session) return;
    this.ws = null;
    this.teardown();
    this.peers.clear();
    this.runnerId = '';
    this.lostAt = Date.now();
    this.reconnectAttempts = 0;
    this.setState('reconnecting');
    this.events.onMessage('Connection lost. Reconnecting… (edits you make now will be replaced by the room\'s copy)');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (Date.now() - this.lostAt > GIVE_UP_RECONNECT_MS) {
      this.events.onMessage('Could not reconnect to the collaboration server');
      this.disconnect();
      return;
    }
    const delay = Math.min(15000, 1000 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = window.setTimeout(() => {
      if (this.manualClose || this.state !== 'reconnecting') return;
      this.open(false).catch((error) => {
        // A refusal (room full) is final; a network problem is worth another try.
        if (this.state === 'reconnecting' && /full|room/i.test(String(error?.message))) {
          this.events.onMessage(String(error.message));
          this.disconnect();
        } else if (this.state === 'reconnecting') {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  /** Stop everything that runs while we are in a room, keeping the settings needed to reconnect. */
  private teardown(): void {
    this.pauseLive();
    window.clearTimeout(this.snapshotTimer);
    window.clearTimeout(this.runCheckTimer);
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.digestTimer);
    cancelAnimationFrame(this.cursorFrame);
    this.liveRun.stopCapture();
    this.liveRun.hideViewer();
    this.stateSync.ignoreProps = false;
    this.stateSync.ignoreIncomingProps = false;
    this.pendingRun = false;
    this.buffered = [];
    this.strikes.clear();
    for (const cursor of this.cursors.values()) cursor.el.remove();
    this.cursors.clear();
    this.editor.clearAllRemote();
    this.lastSeq = 0;
  }

  /** Stop sending our edits (while loading a copy of the project, or when leaving). */
  private pauseLive(): void {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queue = [];
    this.stopEdits?.();
    this.stopEdits = null;
    this.stateSync.stop();
    window.removeEventListener('pointermove', this.pointerHandler, true);
    window.removeEventListener('blur', this.leaveHandler);
    document.documentElement.removeEventListener('mouseout', this.mouseOutHandler);
    this.stopPresence?.();
    this.stopPresence = null;
  }

  private setState(state: CollabState): void {
    this.state = state;
    this.events.onChange();
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  /** Nothing is being sent, applied or typed right now, so comparing with the host's project is meaningful. */
  private quiet(): boolean {
    return Date.now() - this.lastActivity > QUIET_MS && this.queue.length === 0 && this.flushTimer === undefined && !this.stateSync.busy;
  }

  // ---- messages from the server -------------------------------------------------

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.reconnectAttempts = 0;
        this.me = { id: msg.id, name: this.session?.name ?? 'Guest', color: '' };
        this.hostId = msg.hostId;
        this.runnerId = msg.runnerId;
        this.lastSeq = msg.seq;
        this.peers.clear();
        for (const peer of msg.peers) this.peers.set(peer.id, peer);
        this.startTimers();
        this.setState('syncing');
        if (this.isHost) this.goLive();
        else this.requestSnapshot();
        break;
      }
      case 'peer-join':
        this.peers.set(msg.peer.id, msg.peer);
        this.events.onMessage(`${msg.peer.name} joined`);
        this.events.onChange();
        break;
      case 'peer-leave': {
        const peer = this.peers.get(msg.id);
        this.peers.delete(msg.id);
        this.cursors.get(msg.id)?.el.remove();
        this.cursors.delete(msg.id);
        this.editor.clearRemote(msg.id);
        if (peer) this.events.onMessage(`${peer.name} left`);
        this.events.onChange();
        break;
      }
      case 'host':
        this.hostId = msg.id;
        // The host we were waiting on left; the new host has the project (or we are the host now).
        if (this.state === 'syncing') {
          if (this.isHost) this.goLive();
          else this.requestSnapshot();
        }
        this.events.onChange();
        break;
      case 'ops':
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        if (this.state === 'live') this.applyOps(msg.ops);
        else if (this.state === 'syncing') this.buffered.push({ seq: msg.seq, ops: msg.ops });
        break;
      case 'ack':
        this.lastSeq = Math.max(this.lastSeq, msg.seq);
        break;
      case 'cursor':
        this.showCursor(msg.from, msg.target, msg.x, msg.y);
        break;
      case 'select': {
        const peer = this.peers.get(msg.from);
        if (peer && this.state === 'live') this.editor.showRemoteSelect(peer.id, peer.color, msg.target, msg.block);
        break;
      }
      case 'drag': {
        const peer = this.peers.get(msg.from);
        if (peer && this.state === 'live') this.editor.showRemoteDrag(peer.id, peer.color, msg.target, msg.block, msg.dx, msg.dy);
        break;
      }
      case 'pong':
        break;
      case 'snapshot-request':
        void this.answerSnapshot(msg.from);
        break;
      case 'snapshot':
        void this.receiveSnapshot(msg.seq, fromBase64(msg.data));
        break;
      case 'snapshot-chunk':
        this.receiveChunk(msg);
        break;
      case 'digest':
        this.checkDigest(msg);
        break;
      case 'repair-request':
        void this.answerRepair(msg.from, msg.names);
        break;
      case 'repair':
        if (this.state === 'live') {
          void this.stateSync.repair(msg.sprites, msg.monitors).then(() => {
            logDiag('sync', 'repaired', msg.sprites?.length ?? 0, 'sprites');
            this.events.onMessage('Fixed something that was out of step');
          });
        }
        break;
      case 'run':
        this.onRunMessage(msg.from, msg.running);
        break;
      case 'error':
        this.events.onMessage(msg.message);
        break;
    }
  }

  private startTimers(): void {
    this.lastHeard = Date.now();
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.digestTimer);
    this.heartbeatTimer = window.setInterval(() => {
      if (Date.now() - this.lastHeard > DEAD_AFTER_MS) {
        this.ws?.close(); // the close handler starts reconnecting
        return;
      }
      this.send({ t: 'ping' });
    }, HEARTBEAT_MS);
    this.digestTimer = window.setInterval(() => this.sendDigest(), DIGEST_EVERY_MS);
  }

  // ---- joining: get the host's project ----------------------------------------------

  private requestSnapshot(): void {
    this.incoming = null;
    this.send({ t: 'snapshot-request' });
    this.armSnapshotTimer(SNAPSHOT_TIMEOUT_MS);
  }

  private armSnapshotTimer(ms: number): void {
    window.clearTimeout(this.snapshotTimer);
    this.snapshotTimer = window.setTimeout(() => {
      if (this.state !== 'syncing') return;
      this.events.onMessage(
        this.incoming
          ? 'The project download stalled. Join again to retry.'
          : 'The host did not send the project in time. Join again to retry.',
      );
      this.disconnect();
    }, ms);
  }

  /** Replace your project with the host's current copy. */
  resync(): void {
    if (this.state !== 'live' || this.isHost) return;
    this.pauseLive();
    this.buffered = [];
    this.setState('syncing');
    this.requestSnapshot();
  }

  private async answerSnapshot(to: string): Promise<void> {
    try {
      // Let anything that is still being applied finish, so the copy is complete.
      await this.stateSync.settle();
      const bytes = await this.vmHost.saveSb3();
      const seq = this.lastSeq;
      const total = Math.max(1, Math.ceil(bytes.length / SNAPSHOT_CHUNK_BYTES));
      if (total > MAX_SNAPSHOT_CHUNKS) {
        this.events.onMessage('The project is too big to send (over about 570 MB)');
        return;
      }
      const id = Math.random().toString(36).slice(2, 10);
      if (total > 20) this.events.onMessage(`Sending the project to a new person (${(bytes.length / 1048576).toFixed(1)} MB)…`);
      for (let index = 0; index < total; index++) {
        // Do not queue more than a few MB at once; wait for the connection to catch up.
        while (this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > SEND_BUFFER_LIMIT) {
          await new Promise((resolve) => window.setTimeout(resolve, 25));
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const part = bytes.subarray(index * SNAPSHOT_CHUNK_BYTES, (index + 1) * SNAPSHOT_CHUNK_BYTES);
        this.send({ t: 'snapshot-chunk', to, id, seq, index, total, data: toBase64(part) });
        if (index % 8 === 7) await new Promise((resolve) => window.setTimeout(resolve, 0)); // let the UI breathe
      }
    } catch (error) {
      console.error(error);
      this.events.onMessage('Could not send the project to the new person');
    }
  }

  /** One piece of the host's project arrived. */
  private receiveChunk(msg: Extract<ServerMessage, { t: 'snapshot-chunk' }>): void {
    if (this.state !== 'syncing') return;
    if (msg.total < 1 || msg.total > MAX_SNAPSHOT_CHUNKS || msg.index < 0 || msg.index >= msg.total) return;
    if (!this.incoming || this.incoming.id !== msg.id) {
      this.incoming = { id: msg.id, total: msg.total, parts: new Array(msg.total), got: 0, shown: 0 };
    }
    const transfer = this.incoming;
    if (msg.total !== transfer.total) return;
    if (!transfer.parts[msg.index]) {
      transfer.parts[msg.index] = fromBase64(msg.data);
      transfer.got++;
    }
    this.armSnapshotTimer(SNAPSHOT_IDLE_MS);

    if (transfer.total > 8) {
      const percent = Math.floor((transfer.got / transfer.total) * 10) * 10;
      if (percent > transfer.shown && transfer.got < transfer.total) {
        transfer.shown = percent;
        this.events.onMessage(`Downloading the project… ${percent}%`);
      }
    }
    if (transfer.got < transfer.total) return;

    this.incoming = null;
    const bytes = new Uint8Array(transfer.parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of transfer.parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    void this.receiveSnapshot(msg.seq, bytes);
  }

  private async receiveSnapshot(seq: number, bytes: Uint8Array): Promise<void> {
    if (this.state !== 'syncing') return;
    window.clearTimeout(this.snapshotTimer);
    try {
      await this.vmHost.load(bytes.buffer as ArrayBuffer);
    } catch (error) {
      console.error(error);
      this.events.onMessage("Could not open the host's project");
      this.disconnect();
      return;
    }
    this.lastSeq = Math.max(this.lastSeq, seq);
    // Edits that happened while we were downloading. Anything already inside the snapshot is skipped.
    const pending = this.buffered.filter((b) => b.seq > seq).sort((a, b) => a.seq - b.seq);
    this.buffered = [];
    this.goLive();
    for (const batch of pending) this.applyOps(batch.ops);
  }

  private goLive(): void {
    this.pauseLive();
    this.setState('live');
    this.touch();
    this.stateSync.start();
    this.stopEdits = this.editor.onLocalEdit((edit) => this.localEdit(edit));
    // The mouse is shown wherever it is in the app, and hidden when it leaves or the app loses focus.
    window.addEventListener('pointermove', this.pointerHandler, true);
    window.addEventListener('blur', this.leaveHandler);
    document.documentElement.addEventListener('mouseout', this.mouseOutHandler);
    this.stopPresence = this.editor.onPresence((presence) => this.send(presence.kind === 'select'
      ? { t: 'select', target: presence.target, block: presence.block }
      : { t: 'drag', target: presence.target, block: presence.block, dx: presence.dx, dy: presence.dy }));
    this.startCursorLoop();
    if (this.runnerId && !this.isRunner) this.beginViewing();
    if (this.reconnectAttempts === 0 && this.lostAt) {
      this.lostAt = 0;
      this.events.onMessage('Reconnected');
    }
  }

  // ---- edits ----------------------------------------------------------------------

  private localEdit(edit: LocalEdit): void {
    this.touch();
    this.stateSync.emitFor(edit.target, { k: 'blocks', target: edit.target, event: edit.event });
  }

  /** Queue an op and send everything queued shortly after, in order, as one message. */
  private enqueue(op: Op): void {
    if (this.state !== 'live') return;
    this.queue.push(op);
    if (this.flushTimer === undefined) {
      this.flushTimer = window.setTimeout(() => this.flushQueue(), FLUSH_MS);
    }
  }

  private flushQueue(): void {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const ops = this.queue;
    this.queue = [];
    if (ops.length) this.send({ t: 'ops', ops });
  }

  private applyOps(ops: Op[]): void {
    this.touch();
    for (const op of ops) void this.stateSync.apply(op);
  }

  // ---- keeping in step ----------------------------------------------------------------

  /** Host: send a fingerprint of the project so everyone else can check they match. */
  private sendDigest(): void {
    if (this.state !== 'live' || !this.isHost || this.runnerId || !this.quiet()) return;
    const digest = this.stateSync.digest();
    this.send({ t: 'digest', seq: this.lastSeq, sprites: digest.sprites, monitors: digest.monitors });
  }

  private checkDigest(host: { seq: number; sprites: Record<string, string>; monitors: string }): void {
    // Only compare when we are at exactly the same point as the host and nothing is in flight.
    if (this.state !== 'live' || this.isHost || this.runnerId || host.seq !== this.lastSeq || !this.quiet()) return;

    const mine = this.stateSync.digest();
    const comparison = compareDigests(mine.sprites, host.sprites);
    const problems: string[] = [];
    if (comparison.structureDiffers || comparison.differing.includes('Stage')) problems.push('@all');
    else problems.push(...comparison.differing);
    if (mine.monitors !== host.monitors) problems.push('@monitors');

    if (problems.length === 0) {
      this.strikes.clear();
      return;
    }
    // One difference can be a change that was still arriving. Two in a row is a real problem.
    for (const key of [...this.strikes.keys()]) if (!problems.includes(key)) this.strikes.delete(key);
    for (const key of problems) this.strikes.set(key, (this.strikes.get(key) ?? 0) + 1);
    const act = problems.filter((key) => (this.strikes.get(key) ?? 0) >= STRIKES_BEFORE_REPAIR);
    if (act.length === 0) return;
    logDiag('sync', 'out of step at seq', this.lastSeq, 'items:', act.join(','), 'differing:', comparison.differing.join(','), 'structure:', comparison.structureDiffers);
    for (const key of act) this.strikes.delete(key);

    const now = Date.now();
    const allowed = act.filter((key) => {
      const recent = (this.repairs.get(key) ?? []).filter((t) => now - t < 60_000);
      this.repairs.set(key, recent);
      if (recent.length >= MAX_REPAIRS_PER_MINUTE) return false;
      recent.push(now);
      return true;
    });
    if (allowed.length < act.length) {
      this.events.onMessage(`${act.filter((k) => !allowed.includes(k)).join(', ')} keeps going out of step. Use "Get host's project again".`);
    }
    if (allowed.length === 0) return;

    if (allowed.includes('@all')) {
      this.events.onMessage('Out of step with the host, getting their project again…');
      this.resync();
      return;
    }
    this.send({ t: 'repair-request', names: allowed.filter((k) => !k.startsWith('@')) });
  }

  private async answerRepair(to: string, names: string[]): Promise<void> {
    try {
      const sprites = await this.stateSync.exportSprites(names);
      const monitors: MonitorState[] = this.stateSync.readMonitors();
      this.send({ t: 'repair', to, seq: this.lastSeq, sprites, monitors });
    } catch (error) {
      console.error(error);
    }
  }

  // ---- live test runs ------------------------------------------------------------------

  /** The Run button. In a room this runs the project here and streams it to everyone. */
  run(): void {
    if (this.state !== 'live' || !this.me) {
      this.vmHost.greenFlag();
      return;
    }
    if (this.isRunner) {
      this.vmHost.greenFlag(); // pressing Run again restarts the test
      return;
    }
    if (this.viewingRun) {
      this.events.onMessage(`${this.nameOf(this.runnerId)} is running a test. Wait until it stops.`);
      return;
    }
    this.pendingRun = true;
    this.send({ t: 'run', running: true });
  }

  /** The Stop button. */
  stop(): void {
    if (this.viewingRun && this.state === 'live') {
      this.events.onMessage(`Only ${this.nameOf(this.runnerId)} can stop their test run.`);
      return;
    }
    if (this.isRunner) void this.endRun(true);
    else this.vmHost.stopAll();
  }

  private nameOf(id: string): string {
    return this.peers.get(id)?.name ?? 'Someone';
  }

  private onRunMessage(from: string, running: boolean): void {
    if (running) {
      this.runnerId = from;
      if (from === this.me?.id) {
        if (this.pendingRun) {
          this.pendingRun = false;
          this.beginRun();
        }
      } else {
        if (this.pendingRun) {
          this.pendingRun = false;
          this.events.onMessage(`${this.nameOf(from)} is already running a test.`);
        }
        if (this.state === 'live') this.beginViewing();
      }
    } else if (from === this.runnerId) {
      this.runnerId = '';
      if (from !== this.me?.id) this.endViewing();
    }
    this.events.onChange();
  }

  private beginRun(): void {
    this.stateSync.ignoreProps = true;
    this.stateSync.ignoreIncomingProps = true;
    this.sawRunStart = false;
    this.liveRun.startCapture();
    this.vmHost.greenFlag();
    // A project with no scripts never "starts", so end the test instead of staying stuck in it.
    window.clearTimeout(this.runCheckTimer);
    this.runCheckTimer = window.setTimeout(() => {
      if (this.isRunner && !this.sawRunStart) void this.endRun(false);
    }, 1500);
  }

  private async endRun(userStopped: boolean): Promise<void> {
    if (this.ending || !this.isRunner) return;
    this.ending = true;
    try {
      window.clearTimeout(this.runCheckTimer);
      if (userStopped) this.vmHost.stopAll();
      this.liveRun.stopCapture();
      this.stateSync.ignoreIncomingProps = false;
      // Send where everything ended up first, then announce that the test is over.
      this.stateSync.finishRun();
      await this.stateSync.settle();
      this.flushQueue();
      this.send({ t: 'run', running: false });
      this.runnerId = '';
      this.events.onChange();
    } finally {
      this.ending = false;
    }
  }

  private beginViewing(): void {
    this.stateSync.ignoreProps = true;
    this.liveRun.showViewer(this.nameOf(this.runnerId));
  }

  private endViewing(): void {
    this.liveRun.hideViewer();
    this.stateSync.ignoreProps = false;
  }

  // ---- cursors -----------------------------------------------------------------------------

  private sendCursor(e: PointerEvent): void {
    this.cursorHidden = false;
    if (!document.hasFocus()) return;
    const now = performance.now();
    if (now - this.lastCursorSent < 40) return;
    this.lastCursorSent = now;
    // Over the blocks: send the spot in the workspace, so it stays on the same block however the others scroll.
    const editor = this.editor.element;
    const overBlocks = editor.offsetParent !== null && e.target instanceof Node && editor.contains(e.target);
    const target = this.vm.editingTarget;
    if (overBlocks && target) {
      const point = this.editor.clientToWorkspace(e.clientX, e.clientY);
      if (point) {
        this.send({ t: 'cursor', target: target.getName(), x: point.x, y: point.y });
        return;
      }
    }
    // Anywhere else: send where it is as a fraction of the window.
    this.send({ t: 'cursor', target: '@window', x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight });
  }

  private hideMyCursor(): void {
    if (this.cursorHidden || this.state !== 'live') return;
    this.cursorHidden = true;
    this.send({ t: 'cursor', target: '@hide', x: 0, y: 0 });
  }

  private showCursor(from: string, target: string, x: number, y: number): void {
    const peer = this.peers.get(from);
    if (!peer) return;
    let cursor = this.cursors.get(from);
    if (!cursor) {
      const el = document.createElement('div');
      el.className = 'cw-cursor';
      el.style.setProperty('--cursor-color', peer.color);
      const arrow = document.createElement('div');
      arrow.className = 'cw-cursor-arrow';
      const label = document.createElement('div');
      label.className = 'cw-cursor-label';
      label.textContent = peer.name;
      el.append(arrow, label);
      this.windowLayer.appendChild(el);
      cursor = { el, target: '', kind: 'window', x, y, dx: x, dy: y, seen: 0 };
      this.cursors.set(from, cursor);
    }
    if (target === '@hide') {
      cursor.seen = 0; // hidden until it moves again
      return;
    }
    const kind = target === '@window' ? 'window' : 'workspace';
    if (kind === 'workspace') {
      if (cursor.target !== target) {
        cursor.dx = x; // jumped to another sprite: don't glide across the screen
        cursor.dy = y;
      }
      cursor.target = target;
    }
    if (cursor.kind !== kind) {
      cursor.kind = kind;
      cursor.dx = x; // changed between the blocks and the rest of the app: jump, don't glide
      cursor.dy = y;
      (kind === 'window' ? this.windowLayer : this.cursorLayer).appendChild(cursor.el);
    }
    Object.assign(cursor, { x, y, seen: performance.now() });
  }

  private startCursorLoop(): void {
    const frame = () => {
      this.cursorFrame = requestAnimationFrame(frame);
      const editing = this.vm.editingTarget?.getName();
      const now = performance.now();
      for (const cursor of this.cursors.values()) {
        cursor.dx += (cursor.x - cursor.dx) * CURSOR_GLIDE;
        cursor.dy += (cursor.y - cursor.dy) * CURSOR_GLIDE;
        const fresh = now - cursor.seen < CURSOR_TIMEOUT_MS;
        if (cursor.kind === 'window') {
          cursor.el.hidden = !fresh;
          if (fresh) cursor.el.style.transform = `translate(${cursor.dx * window.innerWidth}px, ${cursor.dy * window.innerHeight}px)`;
          continue;
        }
        const visible = fresh && cursor.target === editing && this.editor.element.offsetParent !== null;
        const position = visible ? this.editor.workspaceToHost(cursor.dx, cursor.dy) : null;
        cursor.el.hidden = !position;
        if (position) cursor.el.style.transform = `translate(${position.x}px, ${position.y}px)`;
      }
    };
    cancelAnimationFrame(this.cursorFrame);
    frame();
  }

  /** Everyone else in the room, for the people list. */
  describePeers(): { peer: Peer; host: boolean; running: boolean; viewing: string | null }[] {
    return [...this.peers.values()].map((peer) => ({
      peer,
      host: peer.id === this.hostId,
      running: peer.id === this.runnerId,
      viewing: this.cursors.get(peer.id)?.target || null,
    }));
  }
}
