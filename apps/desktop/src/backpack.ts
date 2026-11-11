import { withActivity } from './activity';
import { errorMessage } from './files';

/*
 * The backpack: scripts, costumes and sounds you keep between sprites and projects. Items live in
 * IndexedDB on this computer (not in the project, and never shared in a collaboration room).
 * Drag a block stack onto the backpack to keep it; click an item to bring it into the current sprite.
 */

export type BackpackKind = 'script' | 'costume' | 'sound';

export interface BackpackItem {
  id: string;
  kind: BackpackKind;
  name: string;
  /** A small picture (data URL) for costumes. */
  thumb?: string;
  payload: any;
  added: number;
}

const DB_NAME = 'codewarp-backpack';
const STORE = 'items';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export interface BackpackHooks {
  /** XML of the block stack being dragged or selected, or null. */
  selectedStackXml(): string | null;
  /** Put a saved stack into the current sprite's workspace. */
  insertStackXml(xml: string): void;
  vm: any;
  setStatus(message: string): void;
}

export class Backpack {
  private items: BackpackItem[] = [];
  private readonly list = document.createElement('div');
  private readonly title = document.createElement('button');
  private open = false;
  private dragging = false;

  constructor(private readonly root: HTMLElement, private readonly hooks: BackpackHooks) {
    root.classList.add('cw-backpack');
    this.title.type = 'button';
    this.title.className = 'cw-backpack-title';
    this.title.addEventListener('click', () => this.setOpen(!this.open));
    this.list.className = 'cw-backpack-list';
    root.append(this.title, this.list);
    this.setOpen(false);
    this.watchDrags();
    void this.reload();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle('open', open);
    this.render();
    // The blocks area just got taller or shorter; let the editor measure itself again.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  /** A short message in the corner of the window, visible from any tab. */
  private toast(message: string): void {
    const el = document.createElement('div');
    el.className = 'cw-toast';
    el.textContent = message;
    document.body.appendChild(el);
    window.setTimeout(() => el.remove(), 2600);
  }

  private async reload(): Promise<void> {
    try {
      this.items = ((await run('readonly', (s) => s.getAll())) as BackpackItem[]).sort((a, b) => b.added - a.added);
    } catch (error) {
      console.error('Backpack unavailable', error);
      this.items = [];
    }
    this.render();
  }

  private async save(item: Omit<BackpackItem, 'id' | 'added'>): Promise<void> {
    const full: BackpackItem = { ...item, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, added: Date.now() };
    await run('readwrite', (s) => s.put(full));
    this.items.unshift(full);
    this.render();
    this.hooks.setStatus(`Added "${item.name}" to the backpack`);
    this.toast(`🎒 Added "${item.name}" to the backpack (see the Code tab)`);
  }

  private async remove(id: string): Promise<void> {
    await run('readwrite', (s) => s.delete(id));
    this.items = this.items.filter((i) => i.id !== id);
    this.render();
  }

  // ---- adding ----

  async addScript(xml: string): Promise<void> {
    await this.save({ kind: 'script', name: 'Script', payload: { xml } });
  }

  async addCostume(costume: any): Promise<void> {
    try {
      await this.addCostumeInner(costume);
    } catch (error) {
      this.toast(`Backpack: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async addCostumeInner(costume: any): Promise<void> {
    const data: Uint8Array | undefined = costume.asset?.data;
    if (!data) throw new Error('This costume has no image data yet');
    const format = String(costume.dataFormat);
    const mime = format === 'svg' ? 'image/svg+xml' : format === 'jpg' ? 'image/jpeg' : 'image/png';
    const thumb = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(new Blob([data as BlobPart], { type: mime }));
    });
    await this.save({
      kind: 'costume',
      name: costume.name,
      thumb,
      payload: {
        bytes: data.slice().buffer,
        format,
        rotationCenterX: costume.rotationCenterX,
        rotationCenterY: costume.rotationCenterY,
        bitmapResolution: costume.bitmapResolution,
      },
    });
  }

  async addSound(sound: any): Promise<void> {
    try {
      await this.addSoundInner(sound);
    } catch (error) {
      this.toast(`Backpack: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async addSoundInner(sound: any): Promise<void> {
    const data: Uint8Array | undefined = sound.asset?.data;
    if (!data) throw new Error('This sound has no data yet');
    await this.save({
      kind: 'sound',
      name: sound.name,
      payload: { bytes: data.slice().buffer, format: String(sound.dataFormat), rate: sound.rate, sampleCount: sound.sampleCount },
    });
  }

  // ---- using ----

  private async use(item: BackpackItem): Promise<void> {
    const { vm } = this.hooks;
    if (!vm.editingTarget) throw new Error('No sprite selected');
    if (item.kind === 'script') {
      this.hooks.insertStackXml(item.payload.xml);
      return;
    }
    const storage = vm.runtime.storage;
    const bytes = new Uint8Array(item.payload.bytes);
    if (item.kind === 'costume') {
      const type = item.payload.format === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
      const asset = storage.createAsset(type, item.payload.format, bytes, null, true);
      const md5 = `${asset.assetId}.${item.payload.format}`;
      await vm.addCostume(md5, {
        name: item.name,
        dataFormat: item.payload.format,
        asset,
        md5,
        assetId: asset.assetId,
        rotationCenterX: item.payload.rotationCenterX,
        rotationCenterY: item.payload.rotationCenterY,
        bitmapResolution: item.payload.bitmapResolution,
      });
    } else {
      const asset = storage.createAsset(storage.AssetType.Sound, item.payload.format, bytes, null, true);
      const md5 = `${asset.assetId}.${item.payload.format}`;
      await vm.addSound({
        name: item.name,
        dataFormat: item.payload.format,
        format: '',
        rate: item.payload.rate,
        sampleCount: item.payload.sampleCount,
        asset,
        md5,
        assetId: asset.assetId,
      });
    }
    this.hooks.setStatus(`Added "${item.name}" to this sprite`);
  }

  // ---- dragging a script onto the backpack ----

  private watchDrags(): void {
    document.addEventListener(
      'pointermove',
      (e) => {
        const dragging = !!document.querySelector('.blocklyDragging');
        if (dragging !== this.dragging) {
          this.dragging = dragging;
          this.root.classList.toggle('cw-drop-ready', dragging);
        }
        if (dragging) this.root.classList.toggle('cw-drop-over', this.isOver(e));
      },
      true,
    );
    document.addEventListener(
      'pointerup',
      (e) => {
        if (!this.dragging) return;
        const over = this.isOver(e);
        const xml = over ? this.hooks.selectedStackXml() : null;
        this.dragging = false;
        this.root.classList.remove('cw-drop-ready', 'cw-drop-over');
        if (xml) void this.addScript(xml).catch((err) => this.hooks.setStatus(`Backpack: ${errorMessage(err)}`));
      },
      true,
    );
  }

  private isOver(e: PointerEvent): boolean {
    const r = this.root.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  // ---- drawing ----

  private render(): void {
    this.title.textContent = `🎒 Backpack (${this.items.length}) ${this.open ? '▾' : '▸'}`;
    this.list.hidden = !this.open;
    this.list.replaceChildren();
    if (!this.open) return;
    if (this.items.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'cw-backpack-empty';
      hint.textContent = 'Drag a block stack here, or use 🎒 on a costume or sound.';
      this.list.appendChild(hint);
    }
    for (const item of this.items) {
      const card = document.createElement('div');
      card.className = `cw-backpack-item cw-backpack-${item.kind}`;
      card.title = `${item.name} — click to add to this sprite`;
      if (item.thumb) {
        const img = document.createElement('img');
        img.src = item.thumb;
        img.alt = '';
        card.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'cw-backpack-icon';
        icon.textContent = item.kind === 'script' ? '🧩' : '🔊';
        card.appendChild(icon);
      }
      const label = document.createElement('span');
      label.className = 'cw-backpack-label';
      label.textContent = item.kind === 'script' ? 'Script' : item.name;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cw-backpack-del';
      del.textContent = '✕';
      del.title = 'Remove from backpack';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.remove(item.id);
      });
      card.append(label, del);
      card.addEventListener('click', () => void withActivity(`Adding ${item.kind === 'script' ? 'script' : item.name}…`, () => this.use(item)).catch((err) => this.hooks.setStatus(`Backpack: ${errorMessage(err)}`)));
      this.list.appendChild(card);
    }
  }
}
