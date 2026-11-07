import * as vmModule from 'scratch-vm';
import * as renderModule from 'scratch-render';
import * as storageModule from 'scratch-storage';
import * as audioModule from 'scratch-audio';
import * as svgModule from 'scratch-svg-renderer';
import * as jszipModule from 'jszip';
import { emptyProjectJson, emptyProjectAssets } from '@codewarp/core';
import { interop } from './interop';
import { md5 } from './md5';

/** An image file to turn into a sprite's first costume. */
export interface SpriteImage {
  data: Uint8Array;
  /** File extension: svg, png, jpg. */
  ext: 'svg' | 'png' | 'jpg';
  /** Size in pixels (for svg, its natural size); the rotation center is put in the middle. */
  width: number;
  height: number;
}

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

  /** Draw the stage at `scale` times its normal size (full screen), or 1 for normal. Keeps it sharp when enlarged. */
  setStageResolution(scale: number): void {
    try {
      this.renderer.resize(Math.round(480 * scale), Math.round(360 * scale));
    } catch (error) {
      console.warn('Could not resize the stage', error);
    }
  }

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
    for (const [fileName, content] of Object.entries(emptyProjectAssets())) {
      zip.file(fileName, content);
    }
    const bytes: ArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    await this.load(bytes);
  }

  /**
   * Add a sprite whose only costume is the given image. The sprite is built as an in-memory
   * .sprite3 file (a zip with sprite.json and the image) because scratch-vm only reads costume
   * assets from a zip or from Scratch's servers.
   */
  async addSpriteFromImage(name: string, image: SpriteImage): Promise<void> {
    const JSZip: any = interop(jszipModule, 'JSZip');
    const assetId = md5(image.data);
    const md5ext = `${assetId}.${image.ext}`;
    const isBitmap = image.ext !== 'svg';

    const costume: Record<string, unknown> = {
      assetId,
      name: 'costume1',
      md5ext,
      dataFormat: image.ext,
      rotationCenterX: Math.round(image.width / 2),
      rotationCenterY: Math.round(image.height / 2),
    };
    if (isBitmap) costume.bitmapResolution = 1;

    const spriteJson = {
      isStage: false,
      name,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [costume],
      sounds: [],
      volume: 100,
      layerOrder: 1,
      visible: true,
      x: 0,
      y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: 'all around',
    };

    const zip = new JSZip();
    zip.file('sprite.json', JSON.stringify(spriteJson));
    zip.file(md5ext, image.data);
    const bytes: ArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
    await this.vm.addSprite(bytes);
  }

  deleteSprite(targetId: string): void {
    this.vm.deleteSprite(targetId);
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
