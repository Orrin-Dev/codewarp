import { Map as ImmutableMap, Record as ImmutableRecord } from 'immutable';
import type { AssetBlob, CostumeMeta, MonitorState, Op, SoundMeta, SpriteProps, SpriteState } from '@codewarp/core';
import type { VmHost } from './vmHost';
import {
  type FullSpriteState,
  costumeKey,
  diffSprite,
  hashValue,
  planList,
  round2,
  soundKey,
} from './syncModel';

/*
 * Keeps everything that is not a block edit in step between people: sprites (added, deleted, renamed),
 * costumes, sounds, position/rotation/size/visibility, and which monitors are showing.
 *
 * It works by comparing the project with the last state that was shared ("baseline") and sending
 * only the difference. Remote changes are applied one at a time, and after each one the baseline is
 * updated so the change is not sent back.
 */

// Same shape as scratch-vm's own monitor-record.js. The VM needs real records (it reads them as properties).
const MonitorRecord: any = (ImmutableRecord as any)({
  id: null,
  spriteName: null,
  targetId: null,
  opcode: null,
  value: null,
  params: null,
  mode: 'default',
  sliderMin: 0,
  sliderMax: 100,
  isDiscrete: true,
  x: null,
  y: null,
  width: 0,
  height: 0,
  visible: true,
});

const FLUSH_DELAY_MS = 150;
const MAX_VALUE_JSON = 100_000;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const plain = <T>(value: unknown): T => (value == null ? (value as T) : JSON.parse(JSON.stringify(value)));

export class StateSync {
  /** Set while a live test runs (here or elsewhere): position/rotation changes are not sent. */
  ignoreProps = false;
  /** Set only on the person running the test: scripts decide where their sprites are, not other people. */
  ignoreIncomingProps = false;
  /** Applies a block edit from someone else; set by the owner so block edits keep their order with state changes. */
  blocksHandler: (op: Extract<Op, { k: 'blocks' }>) => void = () => {};
  /** Called when something was applied from, or sent to, other people. Used to tell when things are quiet. */
  onActivity: () => void = () => {};
  /** Called when a remote change could not be applied, so the caller can ask for a repair. */
  onProblem: (message: string) => void = () => {};

  private baseline = new Map<string, FullSpriteState>();
  private baselineMonitors = '';
  private running = false;
  private applying = 0;
  private pending = 0;
  /** Sprites that existed when the baseline was taken, by VM id (a sprite the VM renames while being added is not a rename). */
  private knownIds = new Set<string>();
  private flushing = false;
  private flushAgain = false;
  private timer: number | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly exporting = new Set<string>();
  private readonly held = new Map<string, Op[]>();
  private cleanup: (() => void)[] = [];

  constructor(
    private readonly host: VmHost,
    private readonly emit: (op: Op) => void,
  ) {}

  private get vm(): any {
    return this.host.vm;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Start watching. The current project becomes the shared baseline. */
  start(): void {
    this.stop();
    this.running = true;
    this.rebaseAll();

    const schedule = () => this.schedule();
    this.vm.addListener('targetsUpdate', schedule);
    this.vm.addListener('MONITORS_UPDATE', schedule);
    this.vm.addListener('PROJECT_CHANGED', schedule);
    this.cleanup.push(
      () => this.vm.removeListener('targetsUpdate', schedule),
      () => this.vm.removeListener('MONITORS_UPDATE', schedule),
      () => this.vm.removeListener('PROJECT_CHANGED', schedule),
    );

    // The VM has no event for renames, and a rename must not look like "delete + add".
    const original = this.vm.renameSprite;
    this.vm.renameSprite = (targetId: string, newName: string) => {
      const target = this.vm.runtime.getTargetById(targetId);
      const before: string | undefined = target?.sprite?.name;
      const result = original.call(this.vm, targetId, newName);
      const after: string | undefined = target?.sprite?.name;
      if (this.applying === 0 && before && after && before !== after && this.knownIds.has(targetId)) this.localRename(before, after);
      return result;
    };
    this.cleanup.push(() => {
      this.vm.renameSprite = original;
    });
  }

  stop(): void {
    this.running = false;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    for (const undo of this.cleanup) undo();
    this.cleanup = [];
    this.held.clear();
    this.exporting.clear();
  }

  /** Forget what was shared and start again from the project as it is now (after loading a copy of someone's project). */
  rebaseAll(): void {
    this.baseline = this.readAll();
    this.baselineMonitors = stringifyMonitors(this.readMonitors());
  }

  /** True while there are local changes not sent yet, or remote changes being applied. */
  get busy(): boolean {
    return this.timer !== undefined || this.flushing || this.applying > 0 || this.pending > 0 || this.exporting.size > 0;
  }

  // ---- reading the project ----------------------------------------------------

  private originals(): any[] {
    return this.vm.runtime.targets.filter((t: any) => t.isOriginal);
  }

  findTarget(name: string): any | undefined {
    return this.originals().find((t) => t.getName() === name);
  }

  private costumeMeta(c: any): CostumeMeta {
    return {
      name: c.name,
      assetId: String(c.assetId),
      dataFormat: String(c.dataFormat),
      rotationCenterX: c.rotationCenterX ?? 0,
      rotationCenterY: c.rotationCenterY ?? 0,
      bitmapResolution: c.bitmapResolution ?? 1,
    };
  }

  private soundMeta(s: any): SoundMeta {
    return {
      name: s.name,
      assetId: String(s.assetId),
      dataFormat: String(s.dataFormat),
      rate: s.rate ?? 0,
      sampleCount: s.sampleCount ?? 0,
    };
  }

  readSprite(t: any): FullSpriteState {
    const props: SpriteProps = t.isStage
      ? { x: 0, y: 0, size: 100, direction: 90, visible: true, draggable: false, rotationStyle: 'all around', currentCostume: t.currentCostume }
      : {
          x: round2(t.x),
          y: round2(t.y),
          size: round2(t.size),
          direction: round2(t.direction),
          visible: Boolean(t.visible),
          draggable: Boolean(t.draggable),
          rotationStyle: String(t.rotationStyle),
          currentCostume: t.currentCostume,
        };
    return {
      name: t.getName(),
      props,
      costumes: t.getCostumes().map((c: any) => this.costumeMeta(c)),
      sounds: t.getSounds().map((s: any) => this.soundMeta(s)),
    };
  }

  private readAll(): Map<string, FullSpriteState> {
    const targets = this.originals();
    this.knownIds = new Set(targets.map((t) => t.id));
    return new Map(targets.map((t) => [t.getName(), this.readSprite(t)] as const));
  }

  readMonitors(): MonitorState[] {
    const state = this.vm.runtime.getMonitorState();
    const list: MonitorState[] = state.valueSeq().toArray().map((m: any) => ({
      id: String(m.get('id')),
      spriteName: m.get('spriteName') ?? null,
      opcode: String(m.get('opcode')),
      params: plain<Record<string, unknown>>(m.get('params')) ?? {},
      mode: String(m.get('mode')),
      visible: Boolean(m.get('visible')),
      x: m.get('x') ?? null,
      y: m.get('y') ?? null,
      sliderMin: m.get('sliderMin'),
      sliderMax: m.get('sliderMax'),
      isDiscrete: Boolean(m.get('isDiscrete')),
    }));
    return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Short fingerprint of which monitors exist and are showing. */
  monitorsDigest(): string {
    return hashValue(this.readMonitors().map((m) => [m.id, m.visible, m.mode, m.spriteName]));
  }

  /** Short fingerprint of everything about one sprite that is shared. */
  spriteDigest(t: any): string {
    const blocks = t.blocks._blocks as Record<string, any>;
    const canonical = Object.keys(blocks)
      .sort()
      .map((id) => {
        const b = blocks[id];
        const inputs: Record<string, unknown> = {};
        for (const [name, input] of Object.entries<any>(b.inputs ?? {})) inputs[name] = [input.block ?? null, input.shadow ?? null];
        const fields: Record<string, unknown> = {};
        for (const [name, field] of Object.entries<any>(b.fields ?? {})) fields[name] = [field.value ?? null, field.id ?? null];
        return [
          id,
          b.opcode,
          b.next ?? null,
          b.parent ?? null,
          Boolean(b.shadow),
          b.topLevel ? [Math.round(b.x ?? 0), Math.round(b.y ?? 0)] : null,
          inputs,
          fields,
          b.mutation ? hashValue(b.mutation) : null,
        ];
      });
    const variables = Object.values<any>(t.variables ?? {})
      .map((v) => [v.id, v.name, v.type])
      .sort();
    return hashValue({ blocks: canonical, variables, state: this.readSprite(t) });
  }

  digest(): { sprites: Record<string, string>; monitors: string } {
    const sprites: Record<string, string> = {};
    for (const t of this.originals()) sprites[t.getName()] = this.spriteDigest(t);
    return { sprites, monitors: this.monitorsDigest() };
  }

  // ---- sending changes --------------------------------------------------------

  /** Send an op now, or after the sprite it belongs to has been announced (see sprite-add below). */
  emitFor(spriteName: string, op: Op): void {
    const queue = this.held.get(spriteName);
    if (queue) queue.push(op);
    else this.emit(op);
  }

  private schedule(): void {
    if (!this.running || this.applying > 0 || this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  private localRename(from: string, to: string): void {
    const state = this.baseline.get(from);
    this.baseline.delete(from);
    if (state) this.baseline.set(to, { ...state, name: to });
    const held = this.held.get(from);
    if (held) {
      this.held.delete(from);
      this.held.set(to, held);
    }
    this.emit({ k: 'sprite-rename', from, to });
    this.onActivity();
  }

  /** Compare the project with the baseline and send what changed. */
  async flush(): Promise<void> {
    if (!this.running) return;
    if (this.flushing || this.applying > 0) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      const next = this.readAll();
      const changes: SpriteState[] = [];

      // New sprites: send the whole sprite.
      for (const [name, state] of next) {
        if (this.baseline.has(name)) continue;
        const target = this.findTarget(name);
        if (!target) continue;
        this.baseline.set(name, state);
        this.exporting.add(name);
        this.held.set(name, []);
        try {
          const data: string = await this.vm.exportSprite(target.id, 'base64');
          this.emit({ k: 'sprite-add', name, data });
        } catch (error) {
          console.error('Could not export sprite', error);
          this.onProblem(`Could not share ${name}`);
        } finally {
          this.exporting.delete(name);
          const queued = this.held.get(name) ?? [];
          this.held.delete(name);
          for (const op of queued) this.emit(op);
        }
      }

      // Removed sprites.
      for (const name of [...this.baseline.keys()]) {
        if (next.has(name)) continue;
        this.baseline.delete(name);
        this.emit({ k: 'sprite-delete', name });
      }

      // Changed sprites.
      // Always send the files for added or changed costumes and sounds. Skipping ones we think
      // everyone already has caused "missing file" errors when someone didn't (a deleted then
      // re-added costume, a failed earlier change, a late joiner), and the whole change was lost.
      const known = new Set<string>();
      const needed = new Map<string, AssetBlob>();
      for (const [name, state] of next) {
        const before = this.baseline.get(name);
        const diff = diffSprite(before, state, this.ignoreProps);
        if (!diff) continue;
        changes.push(diff);
        this.baseline.set(name, before && this.ignoreProps ? { ...state, props: before.props } : state);
        const target = this.findTarget(name);
        if (target) {
          for (const c of diff.costumes ?? []) this.collectAsset(needed, known, c.assetId, target.getCostumes());
          for (const s of diff.sounds ?? []) this.collectAsset(needed, known, s.assetId, target.getSounds());
        }
      }
      if (changes.length > 0) {
        const op: Op = { k: 'state', sprites: changes };
        if (needed.size > 0) op.assets = [...needed.values()];
        this.emit(op);
      }

      // Monitors.
      const monitors = this.readMonitors();
      const serialized = stringifyMonitors(monitors);
      if (serialized !== this.baselineMonitors) {
        this.baselineMonitors = serialized;
        this.emit({ k: 'monitors', monitors });
      }

      if (changes.length > 0) this.onActivity();
    } catch (error) {
      console.error('State sync failed', error);
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.schedule();
      }
    }
  }

  /** (Unused now: kept for reference.) Files other people can already have. */
  // @ts-ignore unused
  private knownAssetIds(): Set<string> {
    const ids = new Set<string>();
    for (const state of this.baseline.values()) {
      for (const c of state.costumes) ids.add(c.assetId);
      for (const s of state.sounds) ids.add(s.assetId);
    }
    return ids;
  }

  private collectAsset(into: Map<string, AssetBlob>, known: Set<string>, assetId: string, items: any[]): void {
    if (known.has(assetId) || into.has(assetId)) return;
    const item = items.find((i) => String(i.assetId) === assetId);
    const asset = item?.asset;
    if (!asset?.data) return;
    into.set(assetId, { id: assetId, ext: String(item.dataFormat), data: toBase64(new Uint8Array(asset.data)) });
  }

  /** Send everything that is waiting, and wait until it has gone out (or two seconds have passed). */
  async settle(): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (this.timer !== undefined) {
        window.clearTimeout(this.timer);
        this.timer = undefined;
      }
      if (!this.flushing && this.applying === 0) {
        await this.flush();
        if (!this.flushAgain && this.timer === undefined) return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    }
  }

  /** After a test run: send position/rotation of every sprite and the variable values. */
  finishRun(): void {
    this.ignoreProps = false;
    this.emit({ k: 'values', targets: this.readValues() });
    void this.flush();
  }

  private readValues(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const t of this.originals()) {
      const values: Record<string, unknown> = {};
      for (const v of Object.values<any>(t.variables ?? {})) {
        if (v.type === 'broadcast_msg' || v.isCloud) continue;
        const copy = plain<unknown>(v.value);
        if (JSON.stringify(copy ?? null).length > MAX_VALUE_JSON) continue;
        values[v.id] = copy;
      }
      if (Object.keys(values).length > 0) out[t.getName()] = values;
    }
    return out;
  }

  // ---- applying other people's changes ------------------------------------------

  /** Apply an op someone else sent. Ops are applied strictly one after another. */
  apply(op: Op): Promise<void> {
    this.pending++;
    this.chain = this.chain
      .then(async () => {
        this.applying++;
        try {
          await this.applyNow(op);
        } finally {
          this.applying--;
          this.pending--;
        }
      })
      .catch((error) => {
        console.warn('Could not apply remote change', op.k, error);
        this.onProblem(`Could not apply a change (${op.k})`);
      });
    return this.chain;
  }

  private keepEditing<T>(fn: () => Promise<T>): Promise<T> {
    // Adding a sprite switches to it. Collaborators should stay where they were.
    const editingName: string | undefined = this.vm.editingTarget?.getName();
    return fn().finally(() => {
      if (!editingName) return;
      const back = this.findTarget(editingName);
      if (back && this.vm.editingTarget !== back) this.vm.setEditingTarget(back.id);
    });
  }

  private async applyNow(op: Op): Promise<void> {
    switch (op.k) {
      case 'state': {
        const assets = new Map((op.assets ?? []).map((a) => [a.id, a] as const));
        for (const sprite of op.sprites) await this.applySprite(sprite, assets);
        break;
      }
      case 'sprite-add': {
        if (this.findTarget(op.name)) return; // already there (e.g. both of us have it)
        await this.keepEditing(() => this.vm.addSprite(fromBase64(op.data).buffer));
        const target = this.findTarget(op.name);
        if (!target) throw new Error(`sprite ${op.name} came out under a different name`);
        this.baseline.set(op.name, this.readSprite(target));
        this.knownIds.add(target.id);
        break;
      }
      case 'sprite-delete': {
        const target = this.findTarget(op.name);
        if (target && !target.isStage) this.vm.deleteSprite(target.id);
        this.baseline.delete(op.name);
        break;
      }
      case 'sprite-rename': {
        const target = this.findTarget(op.from);
        if (target && !target.isStage) this.vm.renameSprite(target.id, op.to);
        const state = this.baseline.get(op.from);
        this.baseline.delete(op.from);
        const now = target?.getName();
        if (now) this.baseline.set(now, { ...(state ?? this.readSprite(target)), name: now });
        break;
      }
      case 'monitors':
        this.applyMonitors(op.monitors, false);
        break;
      case 'values':
        this.applyValues(op.targets);
        break;
      case 'blocks':
        this.blocksHandler(op);
        break;
    }
    this.onActivity();
  }

  private async applySprite(change: SpriteState, assets: Map<string, AssetBlob>): Promise<void> {
    const target = this.findTarget(change.name);
    if (!target) return; // sprite is not here (yet); a later digest check repairs this if it matters
    if (change.costumes) await this.applyCostumes(target, change.costumes, assets);
    if (change.sounds) await this.applySounds(target, change.sounds, assets);
    if (change.props && !this.ignoreIncomingProps) this.applyProps(target, change.props);
    this.vm.emitTargetsUpdate(false);
    this.baseline.set(change.name, this.readSprite(target));
  }

  private applyProps(target: any, p: SpriteProps): void {
    if (!target.isStage) {
      target.setXY(p.x, p.y, true);
      target.setDirection(p.direction);
      target.setSize(p.size);
      target.setVisible(p.visible);
      target.setDraggable(p.draggable);
      target.setRotationStyle(p.rotationStyle);
    }
    if (p.currentCostume !== target.currentCostume && p.currentCostume >= 0 && p.currentCostume < target.getCostumes().length) {
      target.setCostume(p.currentCostume);
    }
  }

  /** The stored file for an asset, from this computer's project or from the message. */
  private resolveAsset(assetId: string, ext: string, kind: 'image' | 'sound', blobs: Map<string, AssetBlob>): any {
    for (const t of this.originals()) {
      for (const item of [...t.getCostumes(), ...t.getSounds()]) {
        if (String(item.assetId) === assetId && item.asset) return item.asset;
      }
    }
    const blob = blobs.get(assetId);
    if (!blob) throw new Error(`missing file ${assetId}.${ext}`);
    const storage = this.vm.runtime.storage;
    const type = kind === 'sound' ? storage.AssetType.Sound : ext === 'svg' ? storage.AssetType.ImageVector : storage.AssetType.ImageBitmap;
    const asset = storage.createAsset(type, ext, fromBase64(blob.data), null, true);
    if (asset.assetId !== assetId) console.warn(`File ${assetId} stored as ${asset.assetId}`);
    return asset;
  }

  private async applyCostumes(target: any, desired: CostumeMeta[], blobs: Map<string, AssetBlob>): Promise<void> {
    const current = target.getCostumes().map((c: any) => costumeKey(this.costumeMeta(c)));
    const steps = planList(current, desired.map(costumeKey));
    for (const step of steps) {
      if (step.type === 'add') {
        const meta = desired[step.desiredIndex];
        const asset = this.resolveAsset(meta.assetId, meta.dataFormat, 'image', blobs);
        const md5ext = `${meta.assetId}.${meta.dataFormat}`;
        await this.vm.addCostume(
          md5ext,
          {
            name: meta.name,
            dataFormat: meta.dataFormat,
            asset,
            md5: md5ext,
            assetId: meta.assetId,
            rotationCenterX: meta.rotationCenterX,
            rotationCenterY: meta.rotationCenterY,
            bitmapResolution: meta.bitmapResolution,
          },
          target.id,
        );
      } else if (step.type === 'delete') {
        target.deleteCostume(step.index);
      } else {
        this.vm.reorderCostume(target.id, step.from, step.to);
      }
    }
    renameAll(
      target.getCostumes().map((c: any) => c.name as string),
      desired.map((c) => c.name),
      (i, name) => target.renameCostume(i, name),
    );
  }

  private async applySounds(target: any, desired: SoundMeta[], blobs: Map<string, AssetBlob>): Promise<void> {
    const current = target.getSounds().map((s: any) => soundKey(this.soundMeta(s)));
    const steps = planList(current, desired.map(soundKey));
    for (const step of steps) {
      if (step.type === 'add') {
        const meta = desired[step.desiredIndex];
        const asset = this.resolveAsset(meta.assetId, meta.dataFormat, 'sound', blobs);
        await this.vm.addSound(
          {
            name: meta.name,
            dataFormat: meta.dataFormat,
            format: '',
            rate: meta.rate,
            sampleCount: meta.sampleCount,
            asset,
            md5: `${meta.assetId}.${meta.dataFormat}`,
            assetId: meta.assetId,
          },
          target.id,
        );
      } else if (step.type === 'delete') {
        target.deleteSound(step.index);
      } else {
        this.vm.reorderSound(target.id, step.from, step.to);
      }
    }
    renameAll(
      target.getSounds().map((s: any) => s.name as string),
      desired.map((s) => s.name),
      (i, name) => target.renameSound(i, name),
    );
  }

  /**
   * Make the monitors here match `list`. With `full` set, monitors that are showing here but are not in the
   * list are hidden (used for repairs, where the list is the complete truth).
   */
  applyMonitors(list: MonitorState[], full: boolean): void {
    const runtime = this.vm.runtime;
    const remoteIds = new Set(list.map((m) => m.id));
    for (const m of list) {
      const target = m.spriteName ? this.findTarget(m.spriteName) : null;
      if (m.spriteName && !target) continue;
      const exists = runtime.getMonitorState().has(m.id);
      if (exists) {
        runtime.requestUpdateMonitor(
          ImmutableMap({
            id: m.id,
            visible: m.visible,
            mode: m.mode,
            x: m.x,
            y: m.y,
            sliderMin: m.sliderMin,
            sliderMax: m.sliderMax,
            isDiscrete: m.isDiscrete,
          } as any),
        );
      } else if (m.visible) {
        runtime.requestAddMonitor(
          new MonitorRecord({
            id: m.id,
            targetId: target ? target.id : null,
            spriteName: m.spriteName,
            opcode: m.opcode,
            params: m.params,
            value: '',
            mode: m.mode,
            sliderMin: m.sliderMin,
            sliderMax: m.sliderMax,
            isDiscrete: m.isDiscrete,
            x: m.x,
            y: m.y,
            visible: true,
          }),
        );
      }
      this.setChecked(m.id, m.visible, target?.id ?? null);
    }
    if (full) {
      for (const local of this.readMonitors()) {
        if (local.visible && !remoteIds.has(local.id)) {
          runtime.requestHideMonitor(local.id);
          this.setChecked(local.id, false, null);
        }
      }
    }
    this.baselineMonitors = stringifyMonitors(this.readMonitors());
  }

  /** The palette checkbox next to a reporter block reads this flag. */
  private setChecked(blockId: string, checked: boolean, targetId: string | null): void {
    const block = this.vm.runtime.monitorBlocks.getBlock(blockId);
    if (!block) return;
    block.isMonitored = checked;
    if (targetId) block.targetId = targetId;
  }

  private applyValues(values: Record<string, Record<string, unknown>>): void {
    for (const [spriteName, vars] of Object.entries(values)) {
      const target = this.findTarget(spriteName);
      if (!target) continue;
      for (const [id, value] of Object.entries(vars)) {
        const variable = target.variables?.[id];
        if (variable) variable.value = value;
      }
    }
  }

  // ---- repairs ------------------------------------------------------------------

  /** Export sprites as .sprite3 files (host side of a repair). */
  async exportSprites(names: string[]): Promise<{ name: string; data: string }[]> {
    const out: { name: string; data: string }[] = [];
    for (const name of names) {
      const target = this.findTarget(name);
      if (target && !target.isStage) out.push({ name, data: await this.vm.exportSprite(target.id, 'base64') });
    }
    return out;
  }

  /** Replace sprites with the host's copies (receiver side of a repair). */
  repair(sprites: { name: string; data: string }[], monitors?: MonitorState[]): Promise<void> {
    this.pending++;
    this.chain = this.chain
      .then(async () => {
        this.applying++;
        try {
          await this.keepEditing(async () => {
            for (const { name, data } of sprites) {
              const old = this.findTarget(name);
              if (old && !old.isStage) this.vm.deleteSprite(old.id);
              await this.vm.addSprite(fromBase64(data).buffer);
              const fresh = this.findTarget(name);
              if (fresh) {
                this.baseline.set(name, this.readSprite(fresh));
                this.knownIds.add(fresh.id);
              }
            }
          });
          if (monitors) this.applyMonitors(monitors, true);
        } finally {
          this.applying--;
          this.pending--;
        }
        this.onActivity();
      })
      .catch((error) => {
        console.warn('Repair failed', error);
        this.onProblem('Repair failed');
      });
    return this.chain;
  }
}

function stringifyMonitors(monitors: MonitorState[]): string {
  // Position matters here too, but not the live values, which change constantly while running.
  return hashValue(monitors);
}

/**
 * Rename items so `current` becomes `wanted`. Names have to stay unique, so when the name we want is
 * taken by another item that item is moved out of the way first.
 */
function renameAll(current: string[], wanted: string[], rename: (index: number, name: string) => void): void {
  const names = [...current];
  for (let pass = 0; pass <= names.length + 1; pass++) {
    let changed = false;
    for (let i = 0; i < wanted.length && i < names.length; i++) {
      if (names[i] === wanted[i]) continue;
      const clash = names.findIndex((n, j) => j !== i && n === wanted[i]);
      if (clash >= 0) {
        names[clash] = `cw-tmp-${clash}`;
        rename(clash, names[clash]);
      } else {
        names[i] = wanted[i];
        rename(i, wanted[i]);
      }
      changed = true;
    }
    if (!changed) break;
  }
}
