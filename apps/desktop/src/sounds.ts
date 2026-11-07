import type { VmHost } from './vmHost';
import { pickFile, baseName, errorMessage } from './files';
import {
  type Pcm,
  type Range,
  changeSpeed,
  deleteRange,
  durationOf,
  encodeWav,
  fadeIn,
  fadeOut,
  gain,
  keepRange,
  lengthOf,
  mute,
  normalizeRange,
  reverse,
  waveformPeaks,
} from './audioOps';

const MAX_HISTORY = 30;

/** One edit button: what it does to the selected range (or the whole sound if nothing is selected). */
interface EditOp {
  label: string;
  title: string;
  /** Needs a selection to make sense. */
  needsSelection?: boolean;
  /** Clear the selection afterwards (the length changed). */
  clearsSelection?: boolean;
  run: (pcm: Pcm, range: Range) => Pcm;
}

const OPS: EditOp[] = [
  { label: 'Trim', title: 'Keep only the selection', needsSelection: true, clearsSelection: true, run: (p, r) => keepRange(p, r) },
  { label: 'Delete', title: 'Remove the selection', needsSelection: true, clearsSelection: true, run: (p, r) => deleteRange(p, r) },
  { label: 'Mute', title: 'Silence the selection', needsSelection: true, run: (p, r) => mute(p, r) },
  { label: 'Fade in', title: 'Fade in over the selection (or the whole sound)', run: (p, r) => fadeIn(p, r) },
  { label: 'Fade out', title: 'Fade out over the selection (or the whole sound)', run: (p, r) => fadeOut(p, r) },
  { label: 'Louder', title: 'Raise the volume of the selection (or the whole sound)', run: (p, r) => gain(p, r, 1.25) },
  { label: 'Softer', title: 'Lower the volume of the selection (or the whole sound)', run: (p, r) => gain(p, r, 0.8) },
  { label: 'Reverse', title: 'Play the selection (or the whole sound) backwards', run: (p, r) => reverse(p, r) },
  { label: 'Faster', title: 'Speed up the whole sound (raises pitch)', clearsSelection: true, run: (p) => changeSpeed(p, 1.25) },
  { label: 'Slower', title: 'Slow down the whole sound (lowers pitch)', clearsSelection: true, run: (p) => changeSpeed(p, 0.8) },
];

const seconds = (value: number): string => `${value.toFixed(2)}s`;

/**
 * The Sounds tab: a list of the selected sprite's sounds, and an editor with a waveform where you
 * select a range and trim, fade, reverse and so on. You can also upload or record new sounds.
 * Edits go back to the VM through vm.updateSoundBuffer (which also stores the new WAV file).
 */
export class SoundsPanel {
  private readonly list = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly info = document.createElement('div');
  private readonly empty = document.createElement('div');
  private readonly editor = document.createElement('div');
  private readonly opButtons: { op: EditOp; button: HTMLButtonElement }[] = [];
  private readonly playButton = document.createElement('button');
  private readonly stopButton = document.createElement('button');
  private readonly undoButton = document.createElement('button');
  private readonly redoButton = document.createElement('button');
  private readonly recordButton = document.createElement('button');

  private audioContext: AudioContext | null = null;
  private active = false;
  private signature = '';

  private selected = 0;
  private loadedTargetId: string | null = null;
  private loadedIndex = -1;
  private loadedAssetId = '';
  private saving = false;

  private pcm: Pcm | null = null;
  private past: Pcm[] = [];
  private future: Pcm[] = [];
  private selection: Range | null = null;
  private peaks: { pcm: Pcm; columns: number; min: Float32Array; max: Float32Array } | null = null;

  private source: AudioBufferSourceNode | null = null;
  private playStart = 0;
  private playRange: Range | null = null;
  private playhead: number | null = null;

  private dragAnchor: number | null = null;
  private dragMoved = false;

  private recorder: MediaRecorder | null = null;

  constructor(
    root: HTMLElement,
    private readonly host: VmHost,
    private readonly setStatus: (message: string) => void,
  ) {
    root.classList.add('cw-sounds');

    // ---- left: list + add buttons
    const side = document.createElement('div');
    side.className = 'cw-asset-side';
    this.list.className = 'cw-asset-list';
    const footer = document.createElement('div');
    footer.className = 'cw-asset-footer';
    const upload = document.createElement('button');
    upload.type = 'button';
    upload.textContent = 'Upload';
    upload.addEventListener('click', () => void this.guard(() => this.uploadSound()));
    this.recordButton.type = 'button';
    this.recordButton.textContent = '● Record';
    this.recordButton.addEventListener('click', () => void this.guard(() => this.toggleRecording()));
    footer.append(upload, this.recordButton);
    side.append(this.list, footer);

    // ---- right: editor
    this.editor.className = 'cw-sound-editor';
    const bar = document.createElement('div');
    bar.className = 'cw-sound-bar';

    const transport = document.createElement('div');
    transport.className = 'cw-paint-group';
    this.playButton.type = 'button';
    this.playButton.textContent = '▶ Play';
    this.playButton.title = 'Play the selection (or the whole sound)';
    this.playButton.addEventListener('click', () => this.play());
    this.stopButton.type = 'button';
    this.stopButton.textContent = '■ Stop';
    this.stopButton.addEventListener('click', () => this.stop());
    this.undoButton.type = 'button';
    this.undoButton.textContent = 'Undo';
    this.undoButton.addEventListener('click', () => this.undo());
    this.redoButton.type = 'button';
    this.redoButton.textContent = 'Redo';
    this.redoButton.addEventListener('click', () => this.redo());
    transport.append(this.playButton, this.stopButton, this.undoButton, this.redoButton);

    const effects = document.createElement('div');
    effects.className = 'cw-paint-group';
    for (const op of OPS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = op.label;
      button.title = op.title;
      button.addEventListener('click', () => this.applyOp(op));
      this.opButtons.push({ op, button });
      effects.appendChild(button);
    }
    bar.append(transport, effects);

    this.canvas.className = 'cw-wave';
    this.info.className = 'cw-wave-info';
    const waveWrap = document.createElement('div');
    waveWrap.className = 'cw-wave-wrap';
    waveWrap.appendChild(this.canvas);

    this.empty.className = 'cw-paint-empty';
    this.empty.textContent = 'No sounds yet. Use "Upload" or "Record" to add one.';

    this.editor.append(bar, waveWrap, this.info);
    const right = document.createElement('div');
    right.className = 'cw-sound-main';
    right.append(this.editor, this.empty);
    root.append(side, right);

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    new ResizeObserver(() => this.draw()).observe(waveWrap);

    host.vm.addListener('targetsUpdate', () => this.refresh());
    this.updateControls();
  }

  /** Call when the tab is shown or hidden. Nothing is rendered while hidden. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) this.refresh(true);
    else this.stop();
  }

  private get vm(): any {
    return this.host.vm;
  }

  private audio(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(error);
      this.setStatus(`Sound error: ${errorMessage(error)}`);
    }
  }

  // ---- list ---------------------------------------------------------------

  private refresh(force = false): void {
    if (!this.active) return;
    const target = this.vm.editingTarget;
    if (!target) {
      this.list.replaceChildren();
      this.showEditor(false);
      return;
    }
    const sounds: any[] = target.getSounds();

    if (target.id !== this.loadedTargetId) this.selected = 0;
    if (this.selected >= sounds.length) this.selected = Math.max(0, sounds.length - 1);

    const signature = [target.id, this.selected, ...sounds.map((s) => `${s.name}:${s.assetId}:${s.sampleCount}`)].join('|');
    if (force || signature !== this.signature) {
      this.signature = signature;
      this.renderList(target, sounds);
    }

    if (sounds.length === 0) {
      this.pcm = null;
      this.loadedTargetId = target.id;
      this.loadedIndex = -1;
      this.showEditor(false);
      return;
    }
    // A collaborator may have replaced the sound being edited. Our own edits update loadedAssetId themselves.
    const changedElsewhere = !this.saving && target.id === this.loadedTargetId && String(sounds[this.selected].assetId) !== this.loadedAssetId;
    if (force || changedElsewhere || target.id !== this.loadedTargetId || this.selected !== this.loadedIndex) this.loadSelected();
  }

  private renderList(target: any, sounds: any[]): void {
    this.list.replaceChildren();
    sounds.forEach((sound, index) => {
      const item = document.createElement('div');
      item.className = 'cw-asset';
      if (index === this.selected) item.classList.add('selected');
      item.addEventListener('click', () => {
        if (index === this.selected) return;
        this.stop();
        this.selected = index;
        this.refresh(true);
      });

      const number = document.createElement('span');
      number.className = 'cw-asset-number';
      number.textContent = String(index + 1);

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'cw-asset-name';
      name.value = sound.name;
      name.addEventListener('click', (e) => e.stopPropagation());
      name.addEventListener('change', () => {
        const value = name.value.trim();
        if (value) this.vm.renameSound(index, value);
      });

      const length = document.createElement('span');
      length.className = 'cw-asset-meta';
      length.textContent = sound.rate ? seconds(sound.sampleCount / sound.rate) : '';

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
      button('↓', 'Move down', index === sounds.length - 1, () => this.move(target, index, index + 1));
      button('⧉', 'Duplicate', false, async () => {
        this.stop();
        await this.vm.duplicateSound(index);
        this.selected = index + 1;
        this.refresh(true);
      });
      button('✕', 'Delete', false, () => {
        this.stop();
        this.vm.deleteSound(index);
        this.refresh(true);
      });

      const body = document.createElement('div');
      body.className = 'cw-asset-body';
      const top = document.createElement('div');
      top.className = 'cw-asset-row';
      top.append(name, length);
      body.append(top, actions);

      item.append(number, body);
      this.list.appendChild(item);
    });
  }

  private move(target: any, from: number, to: number): void {
    this.vm.reorderSound(target.id, from, to);
    if (this.selected === from) this.selected = to;
    this.refresh(true);
  }

  // ---- loading into the editor -------------------------------------------

  private showEditor(show: boolean): void {
    this.editor.hidden = !show;
    this.empty.hidden = show;
    if (!show) this.stop();
  }

  private loadSelected(): void {
    const target = this.vm.editingTarget;
    if (!target) return;
    this.stop();
    this.loadedTargetId = target.id;
    this.loadedIndex = this.selected;
    this.loadedAssetId = String(target.getSounds()[this.selected]?.assetId ?? '');
    this.past = [];
    this.future = [];
    this.selection = null;

    const buffer: AudioBuffer | null = this.vm.getSoundBuffer(this.selected);
    if (!buffer) {
      this.pcm = null;
      this.showEditor(true);
      this.setStatus('This sound has no audio data to edit');
      this.draw();
      this.updateControls();
      return;
    }
    this.pcm = this.fromAudioBuffer(buffer);
    this.showEditor(true);
    this.draw();
    this.updateControls();
  }

  private fromAudioBuffer(buffer: AudioBuffer): Pcm {
    return {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()),
    };
  }

  private toAudioBuffer(pcm: Pcm): AudioBuffer {
    const buffer = this.audio().createBuffer(pcm.channels.length, lengthOf(pcm), pcm.sampleRate);
    pcm.channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
    return buffer;
  }

  // ---- editing ------------------------------------------------------------

  private applyOp(op: EditOp): void {
    if (!this.pcm) return;
    if (op.needsSelection && !this.selection) {
      this.setStatus(`Drag on the waveform to select a part first (for "${op.label}")`);
      return;
    }
    const range = normalizeRange(this.pcm, this.selection);
    const result = op.run(this.pcm, range);
    if (lengthOf(result) < 1) {
      this.setStatus("That would leave nothing of the sound. Delete the sound itself instead.");
      return;
    }
    this.commit(result, op.clearsSelection ? null : this.selection);
  }

  /** Make `next` the current sound: remember the old one for undo and write it to the VM. */
  private commit(next: Pcm, selection: Range | null): void {
    if (this.pcm) {
      this.past.push(this.pcm);
      if (this.past.length > MAX_HISTORY) this.past.shift();
    }
    this.future = [];
    this.setPcm(next, selection);
  }

  private setPcm(pcm: Pcm, selection: Range | null): void {
    this.stop();
    this.pcm = pcm;
    this.selection = selection;
    this.draw();
    this.updateControls();
    this.saving = true; // updateSoundBuffer announces the change straight away; that is not a collaborator's edit
    try {
      this.vm.updateSoundBuffer(this.loadedIndex, this.toAudioBuffer(pcm), encodeWav(pcm));
      this.loadedAssetId = String(this.vm.editingTarget.getSounds()[this.loadedIndex]?.assetId ?? this.loadedAssetId);
    } catch (error) {
      console.error(error);
      this.setStatus(`Could not save the edit: ${errorMessage(error)}`);
    } finally {
      this.saving = false;
    }
  }

  private undo(): void {
    const previous = this.past.pop();
    if (!previous || !this.pcm) return;
    this.future.push(this.pcm);
    this.setPcm(previous, null);
  }

  private redo(): void {
    const next = this.future.pop();
    if (!next || !this.pcm) return;
    this.past.push(this.pcm);
    this.setPcm(next, null);
  }

  private updateControls(): void {
    const has = this.pcm !== null;
    this.playButton.disabled = !has;
    this.stopButton.disabled = !has;
    this.undoButton.disabled = this.past.length === 0;
    this.redoButton.disabled = this.future.length === 0;
    for (const { op, button } of this.opButtons) {
      button.disabled = !has || Boolean(op.needsSelection && !this.selection);
    }
    this.updateInfo();
  }

  private updateInfo(): void {
    if (!this.pcm) {
      this.info.textContent = '';
      return;
    }
    const total = `Length ${seconds(durationOf(this.pcm))}`;
    this.info.textContent = this.selection
      ? `${total} · Selection ${seconds((this.selection.end - this.selection.start) / this.pcm.sampleRate)}`
      : `${total} · Drag on the waveform to select a part`;
  }

  // ---- playback -----------------------------------------------------------

  private play(): void {
    if (!this.pcm) return;
    this.stop();
    const ctx = this.audio();
    void ctx.resume();

    const range = normalizeRange(this.pcm, this.selection);
    const source = ctx.createBufferSource();
    source.buffer = this.toAudioBuffer(this.pcm);
    source.connect(ctx.destination);
    source.start(0, range.start / this.pcm.sampleRate, (range.end - range.start) / this.pcm.sampleRate);

    this.source = source;
    this.playStart = ctx.currentTime;
    this.playRange = range;
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.playhead = null;
      this.draw();
    };
    this.animatePlayhead(source);
  }

  private animatePlayhead(source: AudioBufferSourceNode): void {
    const tick = () => {
      if (this.source !== source || !this.pcm || !this.playRange) return;
      const elapsed = this.audio().currentTime - this.playStart;
      this.playhead = this.playRange.start + elapsed * this.pcm.sampleRate;
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private stop(): void {
    const source = this.source;
    this.source = null;
    this.playhead = null;
    if (source) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.pcm) this.draw();
  }

  // ---- waveform -----------------------------------------------------------

  private sampleAt(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const len = this.pcm ? lengthOf(this.pcm) : 0;
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return Math.round(fraction * len);
  }

  private onDown(e: PointerEvent): void {
    if (!this.pcm || e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.dragAnchor = this.sampleAt(e);
    this.dragMoved = false;
  }

  private onMove(e: PointerEvent): void {
    if (this.dragAnchor === null || !this.pcm) return;
    const here = this.sampleAt(e);
    const pixelsPerSample = this.canvas.getBoundingClientRect().width / Math.max(1, lengthOf(this.pcm));
    if (!this.dragMoved && Math.abs(here - this.dragAnchor) * pixelsPerSample < 3) return;
    this.dragMoved = true;
    this.selection = { start: Math.min(this.dragAnchor, here), end: Math.max(this.dragAnchor, here) };
    this.draw();
    this.updateControls();
  }

  private onUp(e: PointerEvent): void {
    if (this.dragAnchor === null) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!this.dragMoved) {
      this.selection = null; // a plain click clears the selection
      this.draw();
      this.updateControls();
    }
    this.dragAnchor = null;
  }

  private draw(): void {
    const canvas = this.canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#14161c';
    ctx.fillRect(0, 0, width, height);

    const mid = height / 2;
    ctx.fillStyle = '#2e3340';
    ctx.fillRect(0, Math.floor(mid), width, 1);

    const pcm = this.pcm;
    if (!pcm || lengthOf(pcm) === 0) return;

    if (!this.peaks || this.peaks.pcm !== pcm || this.peaks.columns !== width) {
      this.peaks = { pcm, columns: width, ...waveformPeaks(pcm, width) };
    }
    const { min, max } = this.peaks;

    // Selection behind the waveform
    const len = lengthOf(pcm);
    if (this.selection) {
      const x0 = (this.selection.start / len) * width;
      const x1 = (this.selection.end / len) * width;
      ctx.fillStyle = 'rgba(109, 124, 255, 0.28)';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    }

    ctx.fillStyle = '#6d7cff';
    for (let x = 0; x < width; x++) {
      const top = mid - max[x] * mid;
      const bottom = mid - min[x] * mid;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }

    if (this.playhead !== null) {
      const x = (this.playhead / len) * width;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.floor(x), 0, Math.max(1, Math.floor(ratio)), height);
    }
  }

  // ---- adding sounds ------------------------------------------------------

  private async addSoundFromPcm(name: string, pcm: Pcm): Promise<void> {
    const storage = this.vm.runtime.storage;
    const asset = storage.createAsset(storage.AssetType.Sound, 'wav', encodeWav(pcm), null, true);
    const md5 = `${asset.assetId}.wav`;
    await this.vm.addSound({
      name,
      dataFormat: 'wav',
      format: '',
      rate: pcm.sampleRate,
      sampleCount: lengthOf(pcm),
      asset,
      md5,
      assetId: asset.assetId,
    });
    const target = this.vm.editingTarget;
    this.selected = Math.max(0, target.getSounds().length - 1);
    this.refresh(true);
  }

  private async decode(bytes: ArrayBuffer): Promise<Pcm> {
    const buffer = await this.audio().decodeAudioData(bytes);
    return this.fromAudioBuffer(buffer);
  }

  private async uploadSound(): Promise<void> {
    const file = await pickFile('audio/*,.wav,.mp3,.ogg,.m4a,.flac');
    if (!file) return;
    const pcm = await this.decode(await file.arrayBuffer());
    await this.addSoundFromPcm(baseName(file.name) || 'sound', pcm);
  }

  private async toggleRecording(): Promise<void> {
    if (this.recorder) {
      this.recorder.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Recording is not available here');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      this.recorder = null;
      this.recordButton.textContent = '● Record';
      this.recordButton.classList.remove('cw-recording');
      void this.guard(async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const pcm = await this.decode(await blob.arrayBuffer());
        const count = this.vm.editingTarget?.getSounds().length ?? 0;
        await this.addSoundFromPcm(`recording${count + 1}`, pcm);
      });
    };
    this.recorder = recorder;
    recorder.start();
    this.recordButton.textContent = '■ Stop recording';
    this.recordButton.classList.add('cw-recording');
  }
}
