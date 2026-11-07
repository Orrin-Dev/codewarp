import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
// Node runs this file directly (types are stripped). In the monorepo the shared protocol is imported from core; the export script rewrites the path.
import type { ClientMessage, Peer, ServerMessage } from '../../core/src/rtc.ts';
import { MAX_PEERS_PER_ROOM, MAX_SNAPSHOT_CHUNKS, FRAME_JPEG, cleanName, cleanRoom, colorFor, DEFAULT_PORT } from '../../core/src/rtc.ts';

/*
 * Codewarp collaboration relay.
 *  - People join a room by name. The first one in is the host.
 *  - Edits are numbered per room and relayed to everyone else, so all clients see one order.
 *  - A newcomer asks the host for a snapshot of the project; the server just forwards it.
 *  - Cursors are relayed and never stored.
 *  - One person at a time can share a live test run; their video frames are relayed to everyone else.
 *  - The host's project fingerprints and sprite repairs are relayed so everyone can stay in step.
 * The server does not understand project data, so it can't corrupt it.
 */

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_PAYLOAD = 64 * 1024 * 1024; // a snapshot is a whole .sb3
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 500);
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES_PER_SECOND = 600; // cursors are throttled client side, this is a safety net

interface Member extends Peer {
  ws: WebSocket;
  joinedAt: number;
  alive: boolean;
  windowStart: number;
  windowCount: number;
}

interface Room {
  name: string;
  seq: number;
  members: Map<string, Member>;
  hostId: string;
  /** Who is sharing a live test run right now, or ''. */
  runnerId: string;
}

const rooms = new Map<string, Room>();

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room: Room, message: ServerMessage, exceptId?: string): void {
  const text = JSON.stringify(message);
  for (const member of room.members.values()) {
    if (member.id !== exceptId && member.ws.readyState === member.ws.OPEN) member.ws.send(text);
  }
}

/** Relay a binary frame, skipping people whose connection is already backed up (they would only fall behind). */
function broadcastFrame(room: Room, frame: Buffer, exceptId: string): void {
  for (const member of room.members.values()) {
    if (member.id === exceptId || member.ws.readyState !== member.ws.OPEN) continue;
    if (member.ws.bufferedAmount > 1024 * 1024) continue;
    member.ws.send(frame, { binary: true });
  }
}

const publicPeer = ({ id, name, color }: Member): Peer => ({ id, name, color });

function oldest(room: Room): Member | undefined {
  let best: Member | undefined;
  for (const member of room.members.values()) {
    if (!best || member.joinedAt < best.joinedAt) best = member;
  }
  return best;
}

function leave(room: Room | undefined, member: Member | undefined): void {
  if (!room || !member) return;
  room.members.delete(member.id);
  if (room.members.size === 0) {
    rooms.delete(room.name);
    return;
  }
  broadcast(room, { t: 'peer-leave', id: member.id });
  if (room.runnerId === member.id) {
    room.runnerId = '';
    broadcast(room, { t: 'run', from: member.id, running: false });
  }
  if (room.hostId === member.id) {
    const next = oldest(room);
    if (next) {
      room.hostId = next.id;
      broadcast(room, { t: 'host', id: next.id });
    }
  }
}

wss.on('connection', (ws) => {
  let room: Room | undefined;
  let me: Member | undefined;

  ws.on('pong', () => {
    if (me) me.alive = true;
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      // Only the person running a test may send video, and only JPEG frames of a sane size.
      const frame = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      if (room && me && room.runnerId === me.id && frame.length > 1 && frame.length <= MAX_FRAME_BYTES && frame[0] === FRAME_JPEG) {
        broadcastFrame(room, frame, me.id);
      }
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // Simple flood protection.
    if (me) {
      const now = Date.now();
      if (now - me.windowStart > 1000) {
        me.windowStart = now;
        me.windowCount = 0;
      }
      if (++me.windowCount > MAX_MESSAGES_PER_SECOND) {
        ws.close(1008, 'Too many messages');
        return;
      }
    }

    if (msg.t === 'join') {
      if (me) return; // already in a room
      const roomName = cleanRoom(String(msg.room ?? ''));
      if (!roomName) {
        send(ws, { t: 'error', message: 'Enter a room name' });
        return;
      }
      let target = rooms.get(roomName);
      if (!target) {
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { t: 'error', message: 'The server is full, try again later' });
          return;
        }
        target = { name: roomName, seq: 0, members: new Map(), hostId: '', runnerId: '' };
        rooms.set(roomName, target);
      }
      if (target.members.size >= MAX_PEERS_PER_ROOM) {
        send(ws, { t: 'error', message: `That room is full (${MAX_PEERS_PER_ROOM} people)` });
        return;
      }
      const id = randomUUID();
      const now = Date.now();
      me = { id, name: cleanName(String(msg.name ?? '')), color: colorFor(id), ws, joinedAt: now, alive: true, windowStart: now, windowCount: 0 };
      room = target;
      const others = [...room.members.values()].map(publicPeer);
      if (room.members.size === 0) room.hostId = id;
      room.members.set(id, me);
      send(ws, { t: 'welcome', id, hostId: room.hostId, peers: others, seq: room.seq, runnerId: room.runnerId });
      broadcast(room, { t: 'peer-join', peer: publicPeer(me) }, id);
      return;
    }

    if (!room || !me) return; // everything below needs a joined room

    switch (msg.t) {
      case 'ops': {
        if (!Array.isArray(msg.ops) || msg.ops.length === 0) return;
        const seq = ++room.seq;
        broadcast(room, { t: 'ops', from: me.id, seq, ops: msg.ops }, me.id);
        send(ws, { t: 'ack', seq });
        break;
      }
      case 'cursor': {
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
        broadcast(room, { t: 'cursor', from: me.id, target: String(msg.target ?? ''), x: msg.x, y: msg.y }, me.id);
        break;
      }
      case 'ping':
        send(ws, { t: 'pong' });
        break;
      case 'digest': {
        if (me.id !== room.hostId || typeof msg.sprites !== 'object' || !msg.sprites) return;
        broadcast(room, { t: 'digest', seq: Number(msg.seq) || 0, sprites: msg.sprites, monitors: String(msg.monitors ?? '') }, me.id);
        break;
      }
      case 'repair-request': {
        const host = room.members.get(room.hostId);
        if (host && host.id !== me.id && Array.isArray(msg.names)) {
          send(host.ws, { t: 'repair-request', from: me.id, names: msg.names.slice(0, 64).map(String) });
        }
        break;
      }
      case 'repair': {
        if (me.id !== room.hostId || !Array.isArray(msg.sprites)) return;
        const to = room.members.get(String(msg.to));
        if (to) send(to.ws, { t: 'repair', seq: Number(msg.seq) || 0, sprites: msg.sprites, monitors: msg.monitors });
        break;
      }
      case 'run': {
        if (msg.running) {
          if (room.runnerId && room.runnerId !== me.id) {
            // Someone else got there first: tell this person who is running, which also answers their request.
            send(ws, { t: 'run', from: room.runnerId, running: true });
            return;
          }
          room.runnerId = me.id;
        } else {
          if (room.runnerId !== me.id) return;
          room.runnerId = '';
        }
        // Everyone is told, including the sender, whose own copy of the message confirms the request.
        broadcast(room, { t: 'run', from: me.id, running: Boolean(msg.running) });
        break;
      }
      case 'snapshot-request': {
        const host = room.members.get(room.hostId);
        if (host && host.id !== me.id) send(host.ws, { t: 'snapshot-request', from: me.id });
        break;
      }
      case 'snapshot-chunk': {
        if (me.id !== room.hostId) return; // only the host answers
        const to = room.members.get(String(msg.to));
        const index = Number(msg.index);
        const total = Number(msg.total);
        const data = String(msg.data ?? '');
        if (!to || !Number.isInteger(index) || !Number.isInteger(total)) return;
        if (total < 1 || total > MAX_SNAPSHOT_CHUNKS || index < 0 || index >= total || data.length > 400_000) return;
        send(to.ws, { t: 'snapshot-chunk', id: String(msg.id ?? '').slice(0, 24), seq: Number(msg.seq) || 0, index, total, data });
        break;
      }
      case 'snapshot': {
        if (me.id !== room.hostId) return; // only the host answers
        const to = room.members.get(String(msg.to));
        if (to) send(to.ws, { t: 'snapshot', seq: Number(msg.seq) || 0, data: String(msg.data ?? '') });
        break;
      }
    }
  });

  ws.on('close', () => leave(room, me));
  ws.on('error', () => ws.close());
});

// Drop connections that stopped answering (closed laptop, lost Wi-Fi).
setInterval(() => {
  for (const room of rooms.values()) {
    for (const member of room.members.values()) {
      if (!member.alive) {
        member.ws.terminate();
        continue;
      }
      member.alive = false;
      member.ws.ping();
    }
  }
}, 30_000).unref();

httpServer.listen(PORT, HOST, () => {
  console.log(`Codewarp collaboration server listening on ${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
