import { MAX_NAME_LENGTH, MAX_ROOM_LENGTH, cleanName } from '@codewarp/core';
import { collabServerUrl } from './collabConfig';
import type { Collab } from './collab';
import { errorMessage } from './files';

const KEY_NAME = 'codewarp.rtc.name';
const KEY_ROOM = 'codewarp.rtc.room';

function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; not important */
  }
}

/**
 * The Collab button in the top bar, the join dialog, and the row of people in the room.
 * `button` shows the state; `peopleHost` receives the list of colored name chips.
 */
export class CollabUi {
  constructor(
    private readonly collab: Collab,
    private readonly button: HTMLButtonElement,
    private readonly peopleHost: HTMLElement,
    private readonly setStatus: (text: string) => void,
  ) {
    button.addEventListener('click', () => {
      if (collab.state === 'offline') this.openJoinDialog();
      else this.openSessionDialog();
    });
    this.render();
  }

  /** Redraw after any change in the collab state. */
  render(): void {
    const { state } = this.collab;
    this.button.classList.toggle('active', state === 'live');
    const labels = { offline: 'Collab', live: 'Collab: live', syncing: 'Collab: syncing…', connecting: 'Collab: connecting…', reconnecting: 'Collab: reconnecting…' };
    this.button.textContent = labels[state];

    this.peopleHost.replaceChildren();
    if (state === 'offline') return;
    const everyone = [
      ...(this.collab.me
        ? [{ peer: { ...this.collab.me, color: 'var(--accent)', name: `${this.collab.me.name} (you)` }, host: this.collab.isHost, running: this.collab.isRunner, viewing: null }]
        : []),
      ...this.collab.describePeers(),
    ];
    for (const { peer, host, running, viewing } of everyone) {
      const chip = document.createElement('span');
      chip.className = 'cw-person';
      chip.style.setProperty('--cursor-color', peer.color);
      chip.textContent = `${running ? '▶ ' : ''}${peer.name}${host ? ' ★' : ''}`;
      chip.title = [host ? 'Host' : '', running ? 'Running a test' : '', viewing ? `Editing ${viewing}` : ''].filter(Boolean).join(' · ');
      this.peopleHost.appendChild(chip);
    }
  }

  // ---- dialogs ------------------------------------------------------------

  private modal(title: string): { box: HTMLElement; close: () => void; buttons: HTMLElement } {
    const overlay = document.createElement('div');
    overlay.className = 'cw-modal-overlay';
    const box = document.createElement('div');
    box.className = 'cw-modal';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const buttons = document.createElement('div');
    buttons.className = 'cw-modal-buttons';
    box.appendChild(heading);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    // Keep typing in the dialog from reaching the block editor's shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      box.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && (e as KeyboardEvent).key === 'Escape') close();
      });
    }
    return { box, close, buttons };
  }

  private field(label: string, input: HTMLInputElement): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'cw-modal-field';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(text, input);
    return wrap;
  }

  private openJoinDialog(): void {
    const { box, close, buttons } = this.modal('Collaborate');
    const intro = document.createElement('p');
    intro.textContent = 'Join a room to edit together. The first person in is the host and everyone else gets a copy of their project. Press Run to test the project live for everyone.';

    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = MAX_NAME_LENGTH;
    name.value = remembered(KEY_NAME, '');
    name.placeholder = 'Your name';
    const room = document.createElement('input');
    room.type = 'text';
    room.maxLength = MAX_ROOM_LENGTH;
    room.value = remembered(KEY_ROOM, '');
    room.placeholder = 'Room name (share it with your team)';

    const server = document.createElement('p');
    server.className = 'cw-modal-hint cw-modal-server';
    server.textContent = `Server: ${collabServerUrl()}`;
    const warning = document.createElement('p');
    warning.className = 'cw-modal-error';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', close);
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'active';
    join.textContent = 'Join';

    const submit = async () => {
      warning.textContent = '';
      const displayName = cleanName(name.value);
      const roomName = room.value.trim();
      if (!roomName) {
        warning.textContent = 'Enter a room name';
        return;
      }
      join.disabled = true;
      join.textContent = 'Joining…';
      try {
        await this.collab.connect(roomName, displayName);
        remember(KEY_NAME, displayName);
        remember(KEY_ROOM, roomName);
        close();
        this.setStatus(`Joined room "${roomName}"`);
      } catch (error) {
        warning.textContent = errorMessage(error);
        join.disabled = false;
        join.textContent = 'Join';
      }
    };
    join.addEventListener('click', () => void submit());
    for (const input of [name, room]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void submit();
      });
    }

    buttons.append(cancel, join);
    box.append(intro, this.field('Your name', name), this.field('Room', room), server, warning, buttons);
    window.setTimeout(() => (name.value ? room : name).focus(), 50);
  }

  private openSessionDialog(): void {
    const { box, close, buttons } = this.modal('Collaboration');
    const info = document.createElement('p');
    const count = this.collab.peers.size + 1;
    info.textContent =
      this.collab.state === 'live'
        ? `You are live with ${count} ${count === 1 ? 'person' : 'people'}. Blocks, sprites, costumes, sounds, positions and monitors are shared, and Run streams a live test to everyone. Differences are checked and repaired automatically.`
        : this.collab.state === 'reconnecting'
          ? 'Connection lost. Trying to reconnect…'
          : 'Connecting…';

    const leave = document.createElement('button');
    leave.type = 'button';
    leave.textContent = 'Leave room';
    leave.addEventListener('click', () => {
      this.collab.disconnect();
      close();
      this.setStatus('Left the room');
    });
    const resync = document.createElement('button');
    resync.type = 'button';
    resync.textContent = "Get host's project again";
    resync.title = 'Replaces your copy with the host\'s current project';
    resync.disabled = this.collab.state !== 'live' || this.collab.isHost;
    resync.addEventListener('click', () => {
      if (!window.confirm("Replace your project with the host's current copy?")) return;
      this.collab.resync();
      close();
    });
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Close';
    done.addEventListener('click', close);
    buttons.append(leave, resync, done);
    box.append(info, buttons);
  }
}
