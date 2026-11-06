/**
 * Draws variable / list / reporter monitors on top of the stage.
 *
 * scratch-vm only keeps the monitor data (which ones are shown, where, and their current value)
 * and emits MONITORS_UPDATE; drawing them is the host app's job (scratch-gui does it in React).
 * The checkboxes next to reporter blocks in the palette turn monitors on and off.
 */

const LABELS: Record<string, string> = {
  motion_xposition: 'x position',
  motion_yposition: 'y position',
  motion_direction: 'direction',
  looks_costumenumbername: 'costume',
  looks_backdropnumbername: 'backdrop',
  looks_size: 'size',
  sound_volume: 'volume',
  sensing_answer: 'answer',
  sensing_loudness: 'loudness',
  sensing_timer: 'timer',
  sensing_username: 'username',
  sensing_current: 'current',
  sensing_mousex: 'mouse x',
  sensing_mousey: 'mouse y',
};

/** Read a field from an Immutable.js Record (property access) or a plain object. */
function field(monitor: any, key: string): any {
  if (monitor && typeof monitor.get === 'function') return monitor.get(key);
  return monitor?.[key];
}

function monitorLabel(monitor: any): string {
  const opcode: string = field(monitor, 'opcode') ?? '';
  const params = field(monitor, 'params');
  const plainParams = params && typeof params.toJS === 'function' ? params.toJS() : params ?? {};
  const spriteName: string | null = field(monitor, 'spriteName') ?? null;
  const base =
    opcode === 'data_variable'
      ? plainParams.VARIABLE
      : opcode === 'data_listcontents'
        ? plainParams.LIST
        : LABELS[opcode] ?? opcode;
  return spriteName ? `${spriteName}: ${base}` : String(base);
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join('\n');
  if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
  return value === undefined || value === null ? '' : String(value);
}

export class MonitorOverlay {
  constructor(private readonly layer: HTMLElement, vm: any) {
    vm.addListener('MONITORS_UPDATE', (monitors: any) => this.render(monitors));
  }

  private render(monitors: any): void {
    const list: any[] =
      monitors && typeof monitors.toArray === 'function'
        ? monitors.toArray()
        : Array.from(monitors?.values?.() ?? []);

    this.layer.replaceChildren();
    let autoIndex = 0;
    for (const monitor of list) {
      if (!field(monitor, 'visible')) continue;

      const box = document.createElement('div');
      const mode: string = field(monitor, 'mode') ?? 'default';
      const isList = field(monitor, 'opcode') === 'data_listcontents';
      box.className = `cw-monitor cw-monitor-${isList ? 'list' : mode}`;

      const x = field(monitor, 'x');
      const y = field(monitor, 'y');
      box.style.left = `${typeof x === 'number' ? x : 5}px`;
      box.style.top = `${typeof y === 'number' ? y : 5 + autoIndex * 28}px`;
      if (typeof x !== 'number' || typeof y !== 'number') autoIndex++;

      if (mode !== 'large' || isList) {
        const label = document.createElement('span');
        label.className = 'cw-monitor-label';
        label.textContent = monitorLabel(monitor);
        box.appendChild(label);
      }

      const value = document.createElement('span');
      value.className = 'cw-monitor-value';
      value.textContent = formatValue(field(monitor, 'value'));
      box.appendChild(value);

      this.layer.appendChild(box);
    }
  }
}
