import * as vmModule from 'scratch-vm';
import * as renderModule from 'scratch-render';
import * as storageModule from 'scratch-storage';
import * as audioModule from 'scratch-audio';
import * as svgModule from 'scratch-svg-renderer';
import * as jszipModule from 'jszip';
import { emptyProjectJson, BLANK_BACKDROP_ID, BLANK_BACKDROP_SVG } from '@codewarp/core';
import { interop } from './interop';

// Resolved when the VM is created (not at import time) so that a failure shows up in the status bar.
function resolveScratchClasses() {
  const VirtualMachine: any = interop(vmModule, 'VirtualMachine');
  const ScratchRender: any = interop(renderModule, 'RenderWebGL');
  const ScratchStorage: any = interop(storageModule, 'ScratchStorage');
  const AudioEngine: any = interop(audioModule, 'AudioEngine');
  const svg = interop<any>(svgModule);
  return { VirtualMachine, ScratchRender, ScratchStorage, AudioEngine, svg };
}

/**
 * Owns the scratch-vm instance plus its renderer, audio and storage.
 * Everything else (blocks editor, sprite list, text view) talks to the VM through this.
 */
export class VmHost {
  readonly vm: any;
  private readonly renderer: any;

  constructor(stageCanvas: HTMLCanvasElement) {
    const { VirtualMachine, ScratchRender, ScratchStorage, AudioEngine, svg } = resolveScratchClasses();
    const { BitmapAdapter, SVGRenderer } = svg;

    this.vm = new VirtualMachine();

    const storage = new ScratchStorage();
    this.vm.attachStorage(storage);

    this.renderer = new ScratchRender(stageCanvas);
    this.vm.attachRenderer(this.renderer);

    this.vm.attachAudioEngine(new AudioEngine());
    this.vm.attachV2SVGAdapter(new SVGRenderer());
    this.vm.attachV2BitmapAdapter(new BitmapAdapter());

    this.vm.setCompatibilityMode(true);
    this.vm.start();
  }

  /** Load an .sb3 (ArrayBuffer) or a project.json string. */
  async load(input: ArrayBuffer | string): Promise<void> {
    await this.vm.loadProject(input);
  }

  async newProject(): Promise<void> {
    // scratch-vm 5 expects a real .sb3 (a zip containing project.json), not a bare JSON string.
    const JSZip: any = interop(jszipModule, 'JSZip');
    const zip = new JSZip();
    zip.file('project.json', emptyProjectJson());
    zip.file(`${BLANK_BACKDROP_ID}.svg`, BLANK_BACKDROP_SVG);
    const bytes: ArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    await this.load(bytes);
  }

  /** Serialize the current project to .sb3 bytes. */
  async saveSb3(): Promise<Uint8Array> {
    const blob: Blob = await this.vm.saveProjectSb3();
    return new Uint8Array(await blob.arrayBuffer());
  }

  greenFlag(): void {
    this.vm.greenFlag();
  }

  stopAll(): void {
    this.vm.stopAll();
  }

  /** The editing target's block data as parsed project JSON (used by the text-mode preview). */
  editingTargetJson(): unknown {
    const target = this.vm.editingTarget;
    if (!target) return null;
    const project = JSON.parse(this.vm.toJSON());
    const name = target.isStage ? 'Stage' : target.sprite.name;
    return project.targets.find((t: any) => t.name === name) ?? null;
  }
}