import type { VmHost } from './vmHost';
import { PaintEditor, type PaintResult } from './paint';
import { pickFile, baseName, errorMessage } from './files';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the costume image'));
    img.src = url;
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('Could not encode the image'));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/png');
  });
}

interface Prepared {
  width: number;
  height: number;
  draw: ((ctx: CanvasRenderingContext2D) => void) | null;
  cx: number;
  cy: number;
  res: number;
}

/**
 * The Costumes tab: a list of the selected sprite's costumes on the left and a paint editor on the
 * right. Edits are written back to the VM after every change with vm.updateBitmap.
 */
export class CostumesPanel {
  private readonly list = document.createElement('div');
  private readonly paint: PaintEditor;
  private readonly thumbs = new Map<string, string>();

  private active = false;
  private signature = '';
  private loadedTargetId: string | null = null;
  private loadedIndex = -1;
  private loadToken = 0;
  private loadedAssetId = '';
  private lastSaveAt = 0;
  /** When a collaborator last changed this sprite's pictures. */
  private remoteAt = 0;
  private remoteTargetId = '';

  constructor(
    root: HTMLElement,
    private readonly host: VmHost,
    private readonly setStatus: (message: string) => void,
    private readonly toBackpack: (item: any) => Promise<void> = async () => {},
  ) {
    root.classList.add('cw-costumes');
    window.addEventListener('cw-remote-costumes', (e) => {
      this.remoteAt = performance.now();
      this.remoteTargetId = String((e as CustomEvent).detail);
    });

    const side = document.createElement('div');
    side.className = 'cw-asset-side';
    this.list.className = 'cw-asset-list';

    const footer = document.createElement('div');
    footer.className = 'cw-asset-footer';
    const paintNew = document.createElement('button');
    paintNew.type = 'button';
    paintNew.textContent = 'Paint new';
    paintNew.addEventListener('click', () => void this.guard(() => this.paintNewCostume()));
    const upload = document.createElement('button');
    upload.type = 'button';
    upload.textContent = 'Upload';
    upload.addEventListener('click', () => void this.guard(() => this.uploadCostume()));
    footer.append(paintNew, upload);
    side.append(this.list, footer);

    this.paint = new PaintEditor((result) => this.save(result));
    root.append(side, this.paint.element);

    host.vm.addListener('targetsUpdate', () => this.refresh());
  }

  /** Call when the tab is shown or hidden. Nothing is rendered while hidden. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) this.refresh(true);
  }

  private get vm(): any {
    return this.host.vm;
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(error);
      this.setStatus(`Costume error: ${errorMessage(error)}`);
    }
  }

  // ---- list ---------------------------------------------------------------

  private refresh(force = false): void {
    if (!this.active) return;
    const target = this.vm.editingTarget;
    if (!target) {
      this.list.replaceChildren();
      this.paint.clear();
      return;
    }
    const costumes: any[] = target.getCostumes();
    const signature = [target.id, target.currentCostume, ...costumes.map((c) => `${c.name}:${c.assetId}`)].join('|');
    if (force || signature !== this.signature) {
      this.signature = signature;
      this.renderList(target, costumes);
    }

    if (this.paint.busy) return;
    const current = costumes[target.currentCostume];
    let changedElsewhere = false;
    if (current && String(current.assetId) !== this.loadedAssetId && target.id === this.loadedTargetId) {
      // Our own save changes the asset a moment later; anything else (a collaborator's edit) must reload the canvas.
      const remote = this.remoteTargetId === target.id && this.remoteAt >= this.lastSaveAt;
      if (!remote && performance.now() - this.lastSaveAt < 2500) this.loadedAssetId = String(current.assetId);
      else changedElsewhere = true;
    }
    if (force || changedElsewhere || target.id !== this.loadedTargetId || target.currentCostume !== this.loadedIndex) {
      void this.loadSelected();
    }
  }

  private thumbnail(costume: any): string {
    const key = String(costume.assetId);
    const cached = this.thumbs.get(key);
    if (cached !== undefined) return cached;
    let uri = '';
    try {
      uri = costume.asset?.encodeDataURI(MIME[costume.dataFormat] ?? 'image/png') ?? '';
    } catch {
      uri = '';
    }
    this.thumbs.set(key, uri);
    return uri;
  }

  private renderList(target: any, costumes: any[]): void {
    this.list.replaceChildren();
    costumes.forEach((costume, index) => {
      const item = document.createElement('div');
      item.className = 'cw-asset';
      if (index === target.currentCostume) item.classList.add('selected');
      item.addEventListener('click', () => {
        if (index !== target.currentCostume) target.setCostume(index);
      });

      const number = document.createElement('span');
      number.className = 'cw-asset-number';
      number.textContent = String(index + 1);

      const thumb = document.createElement('img');
      thumb.className = 'cw-asset-thumb';
      thumb.alt = '';
      const src = this.thumbnail(costume);
      if (src) thumb.src = src;

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'cw-asset-name';
      name.value = costume.name;
      name.addEventListener('click', (e) => e.stopPropagation());
      name.addEventListener('change', () => {
        const value = name.value.trim();
        if (value) this.vm.renameCostume(index, value);
      });

      const actions = document.createElement('div');
      actions.className = 'cw-asset-actions';
      const button = (label: string, title: string, disabled: boolean, run: () => void | Promise<void>) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.guard(async () => {
            await run();
          });
        });
        actions.appendChild(b);
      };
      button('↑', 'Move up', index === 0, () => this.move(target, index, index - 1));
      button('↓', 'Move down', index === costumes.length - 1, () => this.move(target, index, index + 1));
      button('🎒', 'Add to backpack', false, () => this.toBackpack(costume));
      button('⧉', 'Duplicate', false, async () => {
        await this.vm.duplicateCostume(index);
        this.refresh(true);
      });
      button('✕', costumes.length <= 1 ? 'A sprite needs at least one costume' : 'Delete', costumes.length <= 1, () => {
        this.vm.deleteCostume(index);
        this.refresh(true);
      });

      const body = document.createElement('div');
      body.className = 'cw-asset-body';
      body.append(name, actions);

      item.append(number, thumb, body);
      this.list.appendChild(item);
    });
  }

  private move(target: any, from: number, to: number): void {
    this.vm.reorderCostume(target.id, from, to);
    this.refresh(true);
  }

  // ---- adding costumes ----------------------------------------------------

  private async addCostume(name: string, ext: 'png' | 'jpg' | 'svg', bytes: Uint8Array, extra: object = {}): Promise<void> {
    const storage = this.vm.runtime.storage;
    const assetType = ext === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
    const asset = storage.createAsset(assetType, ext, bytes, null, true);
    const md5ext = `${asset.assetId}.${ext}`;
    await this.vm.addCostume(md5ext, { name, dataFormat: ext, asset, md5: md5ext, assetId: asset.assetId, ...extra });
    this.refresh(true);
  }

  private async paintNewCostume(): Promise<void> {
    const target = this.vm.editingTarget;
    if (!target) return;
    const stage = Boolean(target.isStage);
    const width = stage ? 960 : 128;
    const height = stage ? 720 : 128;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (stage) {
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    const bytes = await canvasToPngBytes(canvas);
    const count = target.getCostumes().length;
    await this.addCostume(stage ? `backdrop${count + 1}` : `costume${count + 1}`, 'png', bytes, {
      rotationCenterX: width / 2,
      rotationCenterY: height / 2,
      bitmapResolution: 2,
    });
  }

  private async uploadCostume(): Promise<void> {
    const file = await pickFile('.png,.jpg,.jpeg,.svg');
    if (!file) return;
    const lower = file.name.toLowerCase();
    const ext = lower.endsWith('.svg') ? 'svg' : lower.endsWith('.png') ? 'png' : /\.jpe?g$/.test(lower) ? 'jpg' : null;
    if (!ext) throw new Error('Use a .png, .jpg or .svg image');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.addCostume(baseName(file.name) || 'costume', ext, bytes);
  }

  // ---- editor <-> VM ------------------------------------------------------

  /** Work out the canvas size, starting pixels and rotation center for a costume. */
  private async prepare(index: number): Promise<Prepared> {
    const costume = this.vm.editingTarget.getCostumes()[index];
    const source: string | null = this.vm.getCostume(index);
    if (!source) throw new Error('This costume has no image data');

    if (costume.dataFormat === 'svg') {
      // Vector costumes are opened as a double-resolution bitmap. Saving turns them into a PNG costume.
      const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
      try {
        const img = await loadImage(url);
        const size: number[] = costume.size ?? [img.naturalWidth || 64, img.naturalHeight || 64];
        const res = 2;
        const width = Math.min(4096, Math.round(size[0] * res));
        const height = Math.min(4096, Math.round(size[1] * res));
        const cx = (typeof costume.rotationCenterX === 'number' ? costume.rotationCenterX : size[0] / 2) * res;
        const cy = (typeof costume.rotationCenterY === 'number' ? costume.rotationCenterY : size[1] / 2) * res;
        return { width, height, cx, cy, res, draw: (ctx) => ctx.drawImage(img, 0, 0, width, height) };
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const img = await loadImage(source);
    const res = costume.bitmapResolution === 2 ? 2 : 1;
    const cx = typeof costume.rotationCenterX === 'number' ? costume.rotationCenterX : img.naturalWidth / 2;
    const cy = typeof costume.rotationCenterY === 'number' ? costume.rotationCenterY : img.naturalHeight / 2;
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      cx,
      cy,
      res,
      draw: (ctx) => ctx.drawImage(img, 0, 0),
    };
  }

  private async loadSelected(): Promise<void> {
    const target = this.vm.editingTarget;
    if (!target) return;
    const index: number = target.currentCostume;
    const token = ++this.loadToken;

    if (!target.getCostumes()[index]) {
      this.paint.clear();
      return;
    }
    try {
      const p = await this.prepare(index);
      if (token !== this.loadToken) return; // the selection changed while loading
      this.loadedTargetId = target.id;
      this.loadedIndex = index;
      this.loadedAssetId = String(target.getCostumes()[index].assetId);
      this.paint.load(p.width, p.height, p.draw, p.cx, p.cy, p.res, !target.isStage);
    } catch (error) {
      console.error(error);
      this.paint.clear();
      this.setStatus(`Could not open costume: ${errorMessage(error)}`);
    }
  }

  private save(result: PaintResult): void {
    const target = this.vm.editingTarget;
    if (!target || target.id !== this.loadedTargetId) return;
    this.lastSaveAt = performance.now();
    this.vm.updateBitmap(this.loadedIndex, result.image, result.centerX, result.centerY, result.resolution);
  }
}
