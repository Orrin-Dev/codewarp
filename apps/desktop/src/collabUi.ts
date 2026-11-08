import { MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH, MAX_ROOM_LENGTH, cleanName } from '@codewarp/core';
import type { RoomInfo } from '@codewarp/core';
import { collabServerUrl } from './collabConfig';
import { fetchRooms, type Collab } from './collab';
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

  /** Join a room. If it is locked, ask for the password in a popup and try again. */
  private async joinRoom(roomName: string, displayName: string, options: { password?: string; unlisted?: boolean } = {}): Promise<void> {
    let password = options.password;
    let reason = '';
    for (;;) {
      try {
        await this.collab.connect(roomName, displayName, { password, unlisted: options.unlisted });
        remember(KEY_NAME, displayName);
        remember(KEY_ROOM, roomName);
        this.setStatus(`Joined room "${roomName}"`);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'password-required' && code !== 'wrong-password') throw error;
        const answer = await this.askPassword(roomName, code === 'wrong-password' ? 'That password is not right. Try again.' : reason);
        if (answer === null) throw new Error('Cancelled');
        password = answer;
        reason = '';
      }
    }
  }

  /** A small popup asking for a room's password. Resolves with the password, or null if cancelled. */
  private askPassword(roomName: string, message: string): Promise<string | null> {
    return new Promise((resolve) => {
      const { box, close, buttons } = this.modal('Password needed');
      const info = document.createElement('p');
      info.textContent = `"${roomName}" is password protected.`;
      const input = document.createElement('input');
      input.type = 'password';
      input.maxLength = MAX_PASSWORD_LENGTH;
      input.placeholder = 'Room password';
      input.autocomplete = 'off';
      const warning = document.createElement('p');
      warning.className = 'cw-modal-error';
      warning.textContent = message;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'active';
      ok.textContent = 'Join';
      let answered = false;
      const finish = (value: string | null) => {
        if (answered) return;
        answered = true;
        close();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      ok.addEventListener('click', () => finish(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value);
        if (e.key === 'Escape') finish(null);
      });
      buttons.append(cancel, ok);
      box.append(info, this.field('Password', input), warning, buttons);
      window.setTimeout(() => input.focus(), 50);
    });
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
    room.placeholder = 'Room name (not case sensitive)';
    const password = document.createElement('input');
    password.type = 'password';
    password.maxLength = MAX_PASSWORD_LENGTH;
    password.placeholder = 'Optional: lock the room with a password';
    password.autocomplete = 'off';
    const hide = document.createElement('input');
    hide.type = 'checkbox';
    const hideRow = document.createElement('label');
    hideRow.className = 'cw-modal-check';
    hideRow.append(hide, document.createTextNode(' Hide this room from the room list'));
    const createHint = document.createElement('p');
    createHint.className = 'cw-modal-hint';
    createHint.textContent = 'The password and hiding only apply when you create a new room. To join a locked room, just enter its name; you will be asked for the password.';

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

    // ---- lobby: the open rooms, with a Join button each ----
    const lobbyHead = document.createElement('div');
    lobbyHead.className = 'cw-lobby-head';
    const lobbyTitle = document.createElement('strong');
    lobbyTitle.textContent = 'Open rooms';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh';
    lobbyHead.append(lobbyTitle, refresh);
    const lobby = document.createElement('div');
    lobby.className = 'cw-lobby';

    const busy = (on: boolean) => {
      join.disabled = on;
      for (const b of lobby.querySelectorAll('button')) b.disabled = on;
    };

    const enter = async (roomName: string, options: { password?: string; unlisted?: boolean } = {}) => {
      warning.textContent = '';
      busy(true);
      join.textContent = 'Joining…';
      try {
        await this.joinRoom(roomName, cleanName(name.value), options);
        close();
      } catch (error) {
        const text = errorMessage(error);
        if (text !== 'Cancelled') warning.textContent = text;
        busy(false);
        join.textContent = 'Join';
      }
    };

    const submit = () => {
      const roomName = room.value.trim();
      if (!roomName) {
        warning.textContent = 'Enter a room name';
        return;
      }
      void enter(roomName, { password: password.value, unlisted: hide.checked });
    };

    const drawLobby = (rooms: RoomInfo[]) => {
      lobby.replaceChildren();
      if (rooms.length === 0) {
        const none = document.createElement('p');
        none.className = 'cw-modal-hint';
        none.textContent = 'No open rooms right now. Make one above.';
        lobby.appendChild(none);
        return;
      }
      for (const info of rooms) {
        const row = document.createElement('div');
        row.className = 'cw-lobby-row';
        const label = document.createElement('span');
        label.className = 'cw-lobby-name';
        label.textContent = `${info.locked ? '🔒 ' : ''}${info.name}`;
        const count = document.createElement('span');
        count.className = 'cw-lobby-count';
        count.textContent = `${info.people}/${info.max}`;
        const go = document.createElement('button');
        go.type = 'button';
        go.textContent = 'Join';
        go.disabled = info.people >= info.max;
        go.addEventListener('click', () => {
          room.value = info.name;
          void enter(info.name);
        });
        row.append(label, count, go);
        lobby.appendChild(row);
      }
    };

    const loadLobby = async () => {
      refresh.disabled = true;
      const loading = document.createElement('p');
      loading.className = 'cw-modal-hint';
      loading.textContent = 'Loading…';
      lobby.replaceChildren(loading);
      try {
        drawLobby(await fetchRooms(collabServerUrl()));
      } catch (error) {
        loading.textContent = `Could not load the list: ${errorMessage(error)}`;
      } finally {
        refresh.disabled = false;
      }
    };
    refresh.addEventListener('click', () => void loadLobby());

    join.addEventListener('click', submit);
    for (const input of [name, room, password]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
    }

    buttons.append(cancel, join);
    box.append(
      intro,
      this.field('Your name', name),
      this.field('Room', room),
      this.field('Password', password),
      hideRow,
      createHint,
      server,
      warning,
      buttons,
      lobbyHead,
      lobby,
    );
    void loadLobby();
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
