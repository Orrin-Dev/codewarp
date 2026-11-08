/**
 * Wire protocol shared by the Codewarp collaboration server and the desktop app.
 * JSON text messages carry everything except live-run video frames, which are binary (see FRAME_*).
 * The server never looks inside `ops`, `data` or digests: it numbers edits, relays messages, and
 * keeps track of who is in which room.
 */

export interface Peer {
  id: string;
  name: string;
  /** CSS color used for this person's cursor. */
  color: string;
}

// ---- project state that is synced as plain data -----------------------------

export interface SpriteProps {
  x: number;
  y: number;
  size: number;
  direction: number;
  visible: boolean;
  draggable: boolean;
  rotationStyle: string;
  currentCostume: number;
}

/** A costume without its image bytes. Two costumes with the same key look identical. */
export interface CostumeMeta {
  name: string;
  assetId: string;
  dataFormat: string;
  rotationCenterX: number;
  rotationCenterY: number;
  bitmapResolution: number;
}

export interface SoundMeta {
  name: string;
  assetId: string;
  dataFormat: string;
  rate: number;
  sampleCount: number;
}

/** The synced state of one sprite. In a `state` op only the parts that changed are present. */
export interface SpriteState {
  name: string;
  props?: SpriteProps;
  costumes?: CostumeMeta[];
  sounds?: SoundMeta[];
}

/** A costume or sound file. `data` is base64. */
export interface AssetBlob {
  id: string;
  ext: string;
  data: string;
}

export interface MonitorState {
  id: string;
  /** Sprite the monitor belongs to, null for the stage. */
  spriteName: string | null;
  opcode: string;
  params: Record<string, unknown>;
  mode: string;
  visible: boolean;
  /** null = placed automatically */
  x: number | null;
  y: number | null;
  sliderMin: number;
  sliderMax: number;
  isDiscrete: boolean;
}

// ---- edits ------------------------------------------------------------------

export type Op =
  /** One Blockly event (Blockly event.toJson()) in the sprite called `target`. */
  | { k: 'blocks'; target: string; event: Record<string, unknown> }
  /** Costumes, sounds and properties of some sprites, plus any files the receiver may not have. */
  | { k: 'state'; sprites: SpriteState[]; assets?: AssetBlob[] }
  /** A whole sprite as a .sprite3 file (base64). */
  | { k: 'sprite-add'; name: string; data: string }
  | { k: 'sprite-delete'; name: string }
  | { k: 'sprite-rename'; from: string; to: string }
  /** Which monitors (the boxes on the stage) exist and which are showing. */
  | { k: 'monitors'; monitors: MonitorState[] }
  /** Variable and list values, sent when a live test run ends. */
  | { k: 'values'; targets: Record<string, Record<string, unknown>> };

// ---- client -> server -------------------------------------------------------

export type ClientMessage =
  /**
   * `password` locks the room when this message creates it, and is required to join a locked room.
   * `unlisted` keeps a room you create out of the lobby list. Both are ignored for an existing room's settings.
   */
  | { t: 'join'; room: string; name: string; password?: string; unlisted?: boolean }
  /** Ask for the list of open rooms (allowed before joining). */
  | { t: 'list' }
  | { t: 'ops'; ops: Op[] }
  /**
   * Where the mouse is. `target` is a sprite name (x, y in workspace units), '@window' (x, y are fractions
   * of the app window, 0 to 1), or '@hide' (the mouse left the app or the app lost focus).
   */
  | { t: 'cursor'; target: string; x: number; y: number }
  /** Dragging a block right now (`block` is '' when the drag ended). dx, dy: how far it moved, in workspace units. */
  | { t: 'drag'; target: string; block: string; dx: number; dy: number }
  /** The block this person has selected (or '' for none). */
  | { t: 'select'; target: string; block: string }
  | { t: 'ping' }
  /** Ask the room host for a full copy of the project. */
  | { t: 'snapshot-request' }
  /** Host's answer. `data` is the .sb3 file, base64. `seq` is the last edit already inside it. */
  | { t: 'snapshot'; to: string; seq: number; data: string }
  /** Host's answer, in pieces: piece `index` of `total` of one .sb3 (each piece base64). `id` names the transfer. */
  | { t: 'snapshot-chunk'; to: string; id: string; seq: number; index: number; total: number; data: string }
  /** Host only: a fingerprint of the project, so everyone else can check they match. */
  | { t: 'digest'; seq: number; sprites: Record<string, string>; monitors: string }
  /** Ask the host for fresh copies of these sprites. */
  | { t: 'repair-request'; names: string[] }
  | { t: 'repair'; to: string; seq: number; sprites: { name: string; data: string }[]; monitors?: MonitorState[] }
  /** Start or stop sharing a live test run. */
  | { t: 'run'; running: boolean };

// ---- server -> client -------------------------------------------------------

export type ServerMessage =
  | { t: 'welcome'; id: string; hostId: string; peers: Peer[]; seq: number; runnerId: string }
  | { t: 'peer-join'; peer: Peer }
  | { t: 'peer-leave'; id: string }
  | { t: 'host'; id: string }
  | { t: 'ops'; from: string; seq: number; ops: Op[] }
  /** Your own ops were accepted and got this sequence number. */
  | { t: 'ack'; seq: number }
  | { t: 'cursor'; from: string; target: string; x: number; y: number }
  | { t: 'drag'; from: string; target: string; block: string; dx: number; dy: number }
  | { t: 'select'; from: string; target: string; block: string }
  | { t: 'pong' }
  | { t: 'snapshot-request'; from: string }
  | { t: 'snapshot'; seq: number; data: string }
  | { t: 'snapshot-chunk'; id: string; seq: number; index: number; total: number; data: string }
  | { t: 'digest'; seq: number; sprites: Record<string, string>; monitors: string }
  | { t: 'repair-request'; from: string; names: string[] }
  | { t: 'repair'; seq: number; sprites: { name: string; data: string }[]; monitors?: MonitorState[] }
  /** `from` started or stopped a live test run. */
  | { t: 'run'; from: string; running: boolean }
  | { t: 'rooms'; rooms: RoomInfo[] }
  /** `code` lets the app react: ask for a password, say the room is full, and so on. */
  | { t: 'error'; message: string; code?: ErrorCode };

export type ErrorCode = 'password-required' | 'wrong-password' | 'room-full' | 'server-full' | 'bad-room';

/** One row of the lobby list. */
export interface RoomInfo {
  name: string;
  people: number;
  max: number;
  /** Needs a password to join. */
  locked: boolean;
}

// ---- live run video ---------------------------------------------------------

/**
 * Binary messages: the first byte says what they are. A FRAME_JPEG message is
 * [1][2 bytes: length of the JSON part, big endian][JSON {"m": {monitorId: value}}][JPEG picture of the stage].
 */
export const FRAME_JPEG = 0x01;

// ---- limits -----------------------------------------------------------------

/** A project is sent to a newcomer in pieces of this many bytes, so its size is not limited by one message. */
export const SNAPSHOT_CHUNK_BYTES = 192 * 1024;
/** At most this many pieces (about 570 MB). */
export const MAX_SNAPSHOT_CHUNKS = 3000;
export const MAX_NAME_LENGTH = 32;
export const MAX_ROOM_LENGTH = 64;
export const MAX_PASSWORD_LENGTH = 64;
export const MAX_LISTED_ROOMS = 100;
export const MAX_PEERS_PER_ROOM = 12;
export const DEFAULT_PORT = 8787;

export function cleanName(name: string): string {
  const trimmed = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || 'Guest';
}

export function cleanRoom(room: string): string {
  return room.trim().slice(0, MAX_ROOM_LENGTH);
}

/** Room names ignore capital letters and spaces at the ends: "Team" and "team " are the same room. */
export function roomKey(room: string): string {
  return cleanRoom(room).toLowerCase();
}

/** A stable, readable color for a peer id. */
export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 75% 55%)`;
}
