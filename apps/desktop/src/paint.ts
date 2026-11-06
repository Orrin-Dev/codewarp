import { floodFill, hexToRgba, rgbaToHex } from './paintOps';

export type PaintTool = 'brush' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse' | 'picker' | 'center';

/** What the editor hands back after every change. */
export interface PaintResult {
  image: ImageData;
  /** Rotation center in canvas pixels. */
  centerX: number;
  centerY: number;
  /** Pixels per stage unit (2 = double resolution). */
  resolution: number;
}

interface Snapshot {
  image: ImageData;
  centerX: number;
  centerY: number;
}

interface Point {
  x: number;
  y: number;
}

const MAX_HISTORY = 40;

const TOOLS: { id: PaintTool; label: string; title: string }[] = [
  { id: 'brush', label: 'Brush', title: 'Freehand drawing' },
  { id: 'eraser', label: 'Eraser', title: 'Erase to transparent' },
  { id: 'fill', label: 'Fill', title: 'Fill an area with the color' },
  { id: 'line', label: 'Line', title: 'Draw a straight line' },
  { id: 'rect', label: 'Rect', title: 'Draw a rectangle' },
  { id: 'ellipse', label: 'Ellipse', title: 'Draw an ellipse' },
  { id: 'picker', label: 'Pick', title: 'Pick a color from the image' },
  { id: 'center', label: 'Center', title: 'Set the point the sprite rotates around' },
];

/**
 * A small bitmap paint editor. It owns a <canvas>, draws on it with pointer input, keeps an
 * undo history, and reports the new pixels through `onCommit` after every finished change.
 */
export class PaintEditor {
  readonly element: HTMLElement;

  private readonly canvas = document.createElement('canvas');
  private readonly overlay = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly stage = document.createElement('div');
  private readonly wrap = document.createElement('div');
  private readonly toolButtons = new Map<PaintTool, HTMLButtonElement>();
  private readonly colorInput = document.createElement('input');
  private readonly sizeInput = document.createElement('input');
  private readonly sizeLabel = document.createElement('span');
  private readonly filledInput = document.createElement('input');
  private readonly undoButton = document.createElement('button');
  private readonly redoButton = document.createElement('button');
  private readonly empty = document.createElement('div');

  private tool: PaintTool = 'brush';
  private resolution = 2;
  private centerX = 0;
  private centerY = 0;
  private showCenter = true;
  private loaded = false;

  private history: Snapshot[] = [];
  private position = -1;

  private drawing = false;
  private start: Point = { x: 0, y: 0 };
  private last: Point = { x: 0, y: 0 };

  constructor(private readonly onCommit: (result: PaintResult) => void) {
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    this.octx = this.overlay.getContext('2d') as CanvasRenderingContext2D;

    this.element = document.createElement('div');
    this.element.className = 'cw-paint';

    this.element.appendChild(this.buildToolbar());

    this.stage.className = 'cw-paint-stage';
    this.wrap.className = 'cw-paint-wrap';
    this.canvas.className = 'cw-paint-canvas';
    this.overlay.className = 'cw-paint-overlay';
    this.wrap.append(this.canvas, this.overlay);
    this.empty.className = 'cw-paint-empty';
    this.empty.textContent = 'Nothing to edit yet. Use "Paint new" or "Upload" to add a costume.';
    this.stage.append(this.wrap, this.empty);
    this.element.appendChild(this.stage);

    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));

    new ResizeObserver(() => this.fit()).observe(this.stage);
    this.setLoaded(false);
  }

  /** True while the user is in the middle of a stroke. */
  get busy(): boolean {
    return this.drawing;
  }

  /** Show "nothing to edit" instead of the canvas. */
  clear(): void {
    this.setLoaded(false);
  }

  /**
   * Load an image to edit. `draw` paints the starting pixels onto the (already sized, empty) canvas;
   * pass null for a blank canvas.
   */
  load(
    width: number,
    height: number,
    draw: ((ctx: CanvasRenderingContext2D) => void) | null,
    centerX: number,
    centerY: number,
    resolution: number,
    showCenter: boolean,
  ): void {
    this.canvas.width = this.overlay.width = Math.max(1, Math.round(width));
    this.canvas.height = this.overlay.height = Math.max(1, Math.round(height));
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    draw?.(this.ctx);

    this.centerX = centerX;
    this.centerY = centerY;
    this.resolution = resolution;
    this.showCenter = showCenter;
    this.drawing = false;
    this.history = [];
    this.position = -1;
    this.pushSnapshot();
    this.setLoaded(true);
    this.fit();
    this.renderOverlay();
  }

  // ---- toolbar ------------------------------------------------------------

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cw-paint-bar';

    const tools = document.createElement('div');
    tools.className = 'cw-paint-group';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.label;
      b.title = t.title;
      b.addEventListener('click', () => this.setTool(t.id));
      this.toolButtons.set(t.id, b);
      tools.appendChild(b);
    }

    const style = document.createElement('div');
    style.className = 'cw-paint-group';
    this.colorInput.type = 'color';
    this.colorInput.value = '#6d7cff';
    this.colorInput.title = 'Color';
    this.sizeInput.type = 'range';
    this.sizeInput.min = '1';
    this.sizeInput.max = '80';
    this.sizeInput.value = '8';
    this.sizeInput.title = 'Brush / line size';
    this.sizeLabel.className = 'cw-paint-size';
    this.sizeLabel.textContent = '8';
    this.sizeInput.addEventListener('input', () => {
      this.sizeLabel.textContent = this.sizeInput.value;
    });
    const filledLabel = document.createElement('label');
    filledLabel.className = 'cw-paint-check';
    this.filledInput.type = 'checkbox';
    filledLabel.append(this.filledInput, ' Filled');
    style.append(this.colorInput, this.sizeInput, this.sizeLabel, filledLabel);

    const actions = document.createElement('div');
    actions.className = 'cw-paint-group';
    const make = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    this.undoButton.type = 'button';
    this.undoButton.textContent = 'Undo';
    this.undoButton.addEventListener('click', () => this.undo());
    this.redoButton.type = 'button';
    this.redoButton.textContent = 'Redo';
    this.redoButton.addEventListener('click', () => this.redo());
    actions.append(
      this.undoButton,
      this.redoButton,
      make('Flip ↔', 'Flip horizontally', () => this.flip(true)),
      make('Flip ↕', 'Flip vertically', () => this.flip(false)),
      make('Clear', 'Erase everything', () => this.clearCanvas()),
    );

    bar.append(tools, style, actions);
    this.setTool('brush');
    this.updateUndoButtons();
    return bar;
  }

  private setTool(tool: PaintTool): void {
    this.tool = tool;
    for (const [id, button] of this.toolButtons) button.classList.toggle('active', id === tool);
    this.overlay.style.cursor = tool === 'picker' || tool === 'center' ? 'crosshair' : 'default';
  }

  private setLoaded(loaded: boolean): void {
    this.loaded = loaded;
    this.wrap.hidden = !loaded;
    this.empty.hidden = loaded;
    this.element.classList.toggle('cw-paint-disabled', !loaded);
  }

  /** Scale the canvas to fit the available space (up to 4x), keeping its aspect ratio. */
  private fit(): void {
    if (!this.loaded) return;
    const availW = Math.max(1, this.stage.clientWidth - 24);
    const availH = Math.max(1, this.stage.clientHeight - 24);
    const scale = Math.min(availW / this.canvas.width, availH / this.canvas.height, 4);
    const w = Math.max(1, Math.floor(this.canvas.width * scale));
    const h = Math.max(1, Math.floor(this.canvas.height * scale));
    for (const c of [this.canvas, this.overlay]) {
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.wrap.style.width = `${w}px`;
    this.wrap.style.height = `${h}px`;
  }

  // ---- pointer input ------------------------------------------------------

  private point(e: PointerEvent): Point {
    const rect = this.overlay.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * this.canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * this.canvas.height) / rect.height,
    };
  }

  private onDown(e: PointerEvent): void {
    if (!this.loaded || e.button !== 0) return;
    e.preventDefault();
    const p = this.point(e);

    switch (this.tool) {
      case 'fill':
        this.fillAt(p);
        return;
      case 'picker':
        this.pickAt(p);
        return;
      case 'center':
        this.centerX = p.x;
        this.centerY = p.y;
        this.renderOverlay();
        this.commit();
        return;
      default:
        break;
    }

    this.overlay.setPointerCapture(e.pointerId);
    this.drawing = true;
    this.start = p;
    this.last = p;
    if (this.tool === 'brush' || this.tool === 'eraser') this.strokeSegment(p, p);
  }

  private onMove(e: PointerEvent): void {
    if (!this.drawing) return;
    const p = this.point(e);
    if (this.tool === 'brush' || this.tool === 'eraser') {
      this.strokeSegment(this.last, p);
      this.last = p;
    } else {
      this.last = p;
      this.renderOverlay();
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.drawing) return;
    this.drawing = false;
    if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
    const p = this.point(e);
    if (this.tool === 'line' || this.tool === 'rect' || this.tool === 'ellipse') {
      this.drawShape(this.ctx, this.start, p);
    }
    this.renderOverlay();
    this.commit();
  }

  // ---- drawing ------------------------------------------------------------

  private strokeSegment(a: Point, b: Point): void {
    const ctx = this.ctx;
    const size = Number(this.sizeInput.value);
    ctx.save();
    ctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = this.colorInput.value;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (a.x === b.x && a.y === b.y) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawShape(ctx: CanvasRenderingContext2D, a: Point, b: Point): void {
    const filled = this.filledInput.checked;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = this.colorInput.value;
    ctx.lineWidth = Number(this.sizeInput.value);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (this.tool === 'line') {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    } else if (this.tool === 'rect') {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      if (filled) ctx.fillRect(x, y, w, h);
      else ctx.strokeRect(x, y, w, h);
    } else {
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      if (filled) ctx.fill();
      else ctx.stroke();
    }
    ctx.restore();
  }

  private fillAt(p: Point): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const image = this.ctx.getImageData(0, 0, w, h);
    const changed = floodFill(image.data, w, h, Math.floor(p.x), Math.floor(p.y), hexToRgba(this.colorInput.value), 32);
    if (changed === 0) return;
    this.ctx.putImageData(image, 0, 0);
    this.commit();
  }

  private pickAt(p: Point): void {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    const [r, g, b, a] = this.ctx.getImageData(x, y, 1, 1).data;
    if (a === 0) return; // transparent: nothing to pick
    this.colorInput.value = rgbaToHex(r, g, b);
  }

  /** Redraw the overlay: the shape being dragged, and the rotation-center marker. */
  private renderOverlay(): void {
    const o = this.octx;
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);

    if (this.drawing && (this.tool === 'line' || this.tool === 'rect' || this.tool === 'ellipse')) {
      this.drawShape(o, this.start, this.last);
    }

    if (this.showCenter) {
      const r = 6 * this.resolution;
      o.save();
      o.lineWidth = Math.max(1, this.resolution);
      for (const [color, extra] of [['#000000', this.resolution], ['#ffffff', 0]] as const) {
        o.strokeStyle = color;
        o.lineWidth = Math.max(1, this.resolution) + extra;
        o.beginPath();
        o.moveTo(this.centerX - r, this.centerY);
        o.lineTo(this.centerX + r, this.centerY);
        o.moveTo(this.centerX, this.centerY - r);
        o.lineTo(this.centerX, this.centerY + r);
        o.stroke();
      }
      o.restore();
    }
  }

  // ---- whole-image actions ------------------------------------------------

  private flip(horizontal: boolean): void {
    if (!this.loaded) return;
    const copy = document.createElement('canvas');
    copy.width = this.canvas.width;
    copy.height = this.canvas.height;
    (copy.getContext('2d') as CanvasRenderingContext2D).drawImage(this.canvas, 0, 0);

    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (horizontal) {
      ctx.translate(this.canvas.width, 0);
      ctx.scale(-1, 1);
      this.centerX = this.canvas.width - this.centerX;
    } else {
      ctx.translate(0, this.canvas.height);
      ctx.scale(1, -1);
      this.centerY = this.canvas.height - this.centerY;
    }
    ctx.drawImage(copy, 0, 0);
    ctx.restore();
    this.renderOverlay();
    this.commit();
  }

  private clearCanvas(): void {
    if (!this.loaded) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.commit();
  }

  // ---- history ------------------------------------------------------------

  private pushSnapshot(): void {
    this.history.length = this.position + 1; // drop the redo tail
    this.history.push({
      image: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
      centerX: this.centerX,
      centerY: this.centerY,
    });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.position = this.history.length - 1;
    this.updateUndoButtons();
  }

  private restore(index: number): void {
    const snap = this.history[index];
    if (!snap) return;
    this.position = index;
    this.ctx.putImageData(snap.image, 0, 0);
    this.centerX = snap.centerX;
    this.centerY = snap.centerY;
    this.renderOverlay();
    this.updateUndoButtons();
    this.emit();
  }

  private undo(): void {
    if (this.loaded && this.position > 0) this.restore(this.position - 1);
  }

  private redo(): void {
    if (this.loaded && this.position < this.history.length - 1) this.restore(this.position + 1);
  }

  private updateUndoButtons(): void {
    this.undoButton.disabled = this.position <= 0;
    this.redoButton.disabled = this.position >= this.history.length - 1;
  }

  /** A change is finished: remember it for undo and report it. */
  private commit(): void {
    this.pushSnapshot();
    this.emit();
  }

  private emit(): void {
    this.onCommit({
      image: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
      centerX: this.centerX,
      centerY: this.centerY,
      resolution: this.resolution,
    });
  }
}
