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

/**
 * The sprite list (pick what you are editing) and a properties panel for the selected sprite:
 * name, position, size, direction, visibility, draggable, and delete.
 */
export class SpritePanel {
  private readonly nameInput: HTMLInputElement;
  private readonly xInput: HTMLInputElement;
  private readonly yInput: HTMLInputElement;
  private readonly sizeInput: HTMLInputElement;
  private readonly directionInput: HTMLInputElement;
  private readonly visibleInput: HTMLInputElement;
  private readonly draggableInput: HTMLInputElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly spriteOnly: HTMLInputElement[];

  private currentId: string | null = null;

  constructor(
    private readonly listRoot: HTMLElement,
    private readonly propsRoot: HTMLElement,
    private readonly host: VmHost,
    private readonly onError: (message: string) => void,
  ) {
    const row = (label: string, input: HTMLElement): HTMLElement => {
      const wrap = document.createElement('label');
      wrap.className = 'cw-prop';
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
    this.deleteButton = document.createElement('button');
    this.deleteButton.type = 'button';
    this.deleteButton.textContent = 'Delete sprite';
    this.deleteButton.className = 'cw-danger';

    this.spriteOnly = [
      this.xInput,
      this.yInput,
      this.sizeInput,
      this.directionInput,
      this.visibleInput,
      this.draggableInput,
    ];

    this.propsRoot.replaceChildren(
      row('Name', this.nameInput),
      row('x', this.xInput),
      row('y', this.yInput),
      row('Size', this.sizeInput),
      row('Direction', this.directionInput),
      row('Show', this.visibleInput),
      row('Draggable', this.draggableInput),
      this.deleteButton,
    );

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
    this.deleteButton.addEventListener('click', () => {
      if (this.currentId) this.host.deleteSprite(this.currentId);
    });

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

  private update(data: TargetsUpdate): void {
    this.currentId = data.editingTarget;

    // Sprite list
    this.listRoot.replaceChildren();
    for (const target of data.targetList) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = target.name;
      if (target.id === data.editingTarget) button.classList.add('active');
      button.addEventListener('click', () => this.host.vm.setEditingTarget(target.id));
      this.listRoot.appendChild(button);
    }

    // Properties of the selected target (skip a field the user is typing in).
    const current = data.targetList.find((t) => t.id === data.editingTarget);
    const set = (input: HTMLInputElement, value: string) => {
      if (document.activeElement !== input) input.value = value;
    };
    if (!current) {
      this.propsRoot.classList.add('cw-disabled');
      return;
    }
    this.propsRoot.classList.remove('cw-disabled');

    set(this.nameInput, current.name);
    this.nameInput.disabled = current.isStage;
    this.deleteButton.disabled = current.isStage;
    for (const input of this.spriteOnly) input.disabled = current.isStage;

    if (!current.isStage) {
      set(this.xInput, String(Math.round(current.x)));
      set(this.yInput, String(Math.round(current.y)));
      set(this.sizeInput, String(Math.round(current.size)));
      set(this.directionInput, String(Math.round(current.direction)));
      this.visibleInput.checked = current.visible;
      this.draggableInput.checked = current.draggable;
    }
  }
}
