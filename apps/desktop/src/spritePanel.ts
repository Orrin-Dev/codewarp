import type { VmHost } from './vmHost';

/** The fields of a target (sprite or stage) that scratch-vm sends with every 'targetsUpdate'. */
interface TargetInfo {
  id: string;
  name: string;
  isStage: boolean;
  x: number;
  y: number;
  size: number;
  direction: number;
  visible: boolean;
  draggable: boolean;
}

interface TargetsUpdate {
  targetList: TargetInfo[];
  editingTarget: string | null;
}

/** One clickable card in the sprite list. */
interface Tile {
  el: HTMLDivElement;
  img: HTMLImageElement;
  label: HTMLSpanElement;
  thumbKey: string;
}

const MAX_THUMBS = 200;

/**
 * The sprite list and the properties of the selected sprite.
 *
 * The list is a row of cards with a picture of each sprite's current costume. The stage has its own card
 * on the left, like in Scratch. Cards are updated in place (not rebuilt), because scratch-vm sends
 * 'targetsUpdate' constantly while a project runs.
 */
export class SpritePanel {
  private readonly nameInput: HTMLInputElement;
  private readonly xInput: HTMLInputElement;
  private readonly yInput: HTMLInputElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly directionInput: HTMLInputElement;
  private readonly visibleInput: HTMLInputElement;
  private readonly draggableInput: HTMLInputElement;
  private readonly stageNote: HTMLElement;
  private readonly stageSlot: HTMLElement;
  private readonly grid: HTMLElement;

  private readonly tiles = new Map<string, Tile>();
  private readonly thumbs = new Map<string, string>();
  private currentId: string | null = null;

  constructor(
    private readonly listRoot: HTMLElement,
    private readonly propsRoot: HTMLElement,
    private readonly host: VmHost,
    private readonly onError: (message: string) => void,
  ) {
    const row = (label: string, input: HTMLElement, cls = ''): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = `cw-prop ${cls}`.trim();
      const text = document.createElement('span');
      text.textContent = label;
      wrap.append(text, input);
      return wrap;
    };
    const make = (type: string, attrs: Record<string, string> = {}): HTMLInputElement => {
      const input = document.createElement('input');
      input.type = type;
      for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
      return input;
    };

    this.nameInput = make('text');
    this.xInput = make('number', { step: '1' });
    this.yInput = make('number', { step: '1' });
    this.sizeInput = make('number', { min: '0', step: '1' });
    this.directionInput = make('number', { step: '1' });
    this.visibleInput = make('checkbox');
    this.draggableInput = make('checkbox');

    this.stageNote = document.createElement('div');
    this.stageNote.className = 'cw-stage-note';

    this.propsRoot.replaceChildren(
      row('Sprite', this.nameInput, 'cw-prop-name'),
      row('Show', this.visibleInput, 'cw-prop-check'),
      row('Draggable', this.draggableInput, 'cw-prop-check'),
      row('x', this.xInput, 'cw-prop-num'),
      row('y', this.yInput, 'cw-prop-num'),
      row('Size', this.sizeInput, 'cw-prop-num'),
      row('Direction', this.directionInput, 'cw-prop-num'),
      this.stageNote,
    );

    this.stageSlot = document.createElement('div');
    this.stageSlot.className = 'cw-stage-slot';
    this.grid = document.createElement('div');
    this.grid.className = 'cw-sprite-grid';
    this.listRoot.replaceChildren(this.stageSlot, this.grid);

    // `change` (on blur / enter) rather than `input`, so typing "-" or "1" mid-edit doesn't apply.
    this.nameInput.addEventListener('change', () => this.rename());
    this.xInput.addEventListener('change', () => this.applyPosition());
    this.yInput.addEventListener('change', () => this.applyPosition());
    this.sizeInput.addEventListener('change', () => this.withTarget((t) => t.setSize(Number(this.sizeInput.value))));
    this.directionInput.addEventListener('change', () =>
      this.withTarget((t) => t.setDirection(Number(this.directionInput.value))),
    );
    this.visibleInput.addEventListener('change', () => this.withTarget((t) => t.setVisible(this.visibleInput.checked)));
    this.draggableInput.addEventListener('change', () =>
      this.withTarget((t) => t.setDraggable(this.draggableInput.checked)),
    );

    host.vm.addListener('targetsUpdate', (data: TargetsUpdate) => this.update(data));
  }

  private withTarget(fn: (target: any) => void): void {
    if (!this.currentId) return;
    const target = this.host.vm.runtime.getTargetById(this.currentId);
    if (!target) return;
    try {
      fn(target);
    } catch (error: any) {
      this.onError(error?.message ?? String(error));
    }
  }

  private applyPosition(): void {
    this.withTarget((t) => t.setXY(Number(this.xInput.value), Number(this.yInput.value)));
  }

  private rename(): void {
    const name = this.nameInput.value.trim();
    if (!this.currentId || !name) return;
    try {
      this.host.vm.renameSprite(this.currentId, name);
    } catch (error: any) {
      this.onError(error?.message ?? String(error));
    }
  }

  /** A picture URL for a target's current costume, cached by asset. */
  private thumbnail(targetId: string): { key: string; url: string } | null {
    const target = this.host.vm.runtime.getTargetById(targetId);
    const costume = target?.getCostumes?.()[target.currentCostume];
    if (!costume) return null;
    const key = `${costume.assetId}.${costume.dataFormat}`;
    let url = this.thumbs.get(key);
    if (!url) {
      const data = costume.asset?.data;
      if (!data) return null;
      const format = String(costume.dataFormat).toLowerCase();
      const type = format === 'svg' ? 'image/svg+xml' : format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : 'image/png';
      url = URL.createObjectURL(new Blob([data], { type }));
      this.thumbs.set(key, url);
      if (this.thumbs.size > MAX_THUMBS) {
        const oldest = this.thumbs.keys().next().value as string;
        URL.revokeObjectURL(this.thumbs.get(oldest)!);
        this.thumbs.delete(oldest);
      }
    }
    return { key, url };
  }

  private makeTile(target: TargetInfo): Tile {
    const el = document.createElement('div');
    el.className = 'cw-tile';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const img = document.createElement('img');
    img.className = 'cw-tile-img';
    img.alt = '';
    img.draggable = false;
    const label = document.createElement('span');
    label.className = 'cw-tile-label';
    el.append(img, label);

    el.addEventListener('click', () => this.host.vm.setEditingTarget(target.id));
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.host.vm.setEditingTarget(target.id);
      }
    });

    if (!target.isStage) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cw-tile-delete';
      del.title = 'Delete sprite';
      del.textContent = '×';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        const name = label.textContent ?? 'this sprite';
        if (window.confirm(`Delete "${name}"?`)) this.host.deleteSprite(target.id);
      });
      el.appendChild(del);
    }
    return { el, img, label, thumbKey: '' };
  }

  private update(data: TargetsUpdate): void {
    this.currentId = data.editingTarget;

    // ---- the cards ----
    const seen = new Set<string>();
    let spriteIndex = 0;
    for (const target of data.targetList) {
      seen.add(target.id);
      let tile = this.tiles.get(target.id);
      if (!tile) {
        tile = this.makeTile(target);
        this.tiles.set(target.id, tile);
      }
      tile.label.textContent = target.isStage ? 'Stage' : target.name;
      tile.el.title = target.name;
      tile.el.classList.toggle('active', target.id === data.editingTarget);
      tile.el.classList.toggle('cw-tile-stage', target.isStage);

      const thumb = this.thumbnail(target.id);
      if (thumb && thumb.key !== tile.thumbKey) {
        tile.thumbKey = thumb.key;
        tile.img.src = thumb.url;
      }
      tile.img.style.visibility = thumb ? 'visible' : 'hidden';

      if (target.isStage) {
        if (tile.el.parentElement !== this.stageSlot) this.stageSlot.replaceChildren(tile.el);
      } else {
        if (this.grid.children[spriteIndex] !== tile.el) this.grid.insertBefore(tile.el, this.grid.children[spriteIndex] ?? null);
        spriteIndex++;
      }
    }
    for (const [id, tile] of this.tiles) {
      if (seen.has(id)) continue;
      tile.el.remove();
      this.tiles.delete(id);
    }

    // ---- the properties of the selected target (skip a field the user is typing in) ----
    const current = data.targetList.find((t) => t.id === data.editingTarget);
    const set = (input: HTMLInputElement, value: string) => {
      if (document.activeElement !== input) input.value = value;
    };
    if (!current) {
      this.propsRoot.classList.add('cw-disabled');
      return;
    }
    this.propsRoot.classList.remove('cw-disabled');
    this.propsRoot.classList.toggle('cw-stage-selected', current.isStage);

    if (current.isStage) {
      const stage = this.host.vm.runtime.getTargetById(current.id);
      const count = stage?.getCostumes?.().length ?? 0;
      this.stageNote.textContent = `The stage has ${count} backdrop${count === 1 ? '' : 's'}. Use the Costumes tab to change them.`;
      return;
    }

    set(this.nameInput, current.name);
    set(this.xInput, String(Math.round(current.x)));
    set(this.yInput, String(Math.round(current.y)));
    set(this.sizeInput, String(Math.round(current.size)));
    set(this.directionInput, String(Math.round(current.direction)));
    this.visibleInput.checked = current.visible;
    this.draggableInput.checked = current.draggable;
  }
}
