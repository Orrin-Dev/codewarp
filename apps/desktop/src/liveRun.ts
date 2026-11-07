import { Map as ImmutableMap } from 'immutable';
import { FRAME_JPEG } from '@codewarp/core';
import type { VmHost } from './vmHost';

const FRAME_INTERVAL_MS = 80; // about 12 pictures a second
const FRAME_WIDTH = 480;
const FRAME_HEIGHT = 360;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_MONITOR_JSON = 20_000;

/**
 * Live test runs. The person pressing Run is the "runner": the project runs only on their computer and a
 * picture of the stage (plus the monitor values) is sent to everyone else about 12 times a second.
 * Everyone else is a "viewer": they see that picture over their own stage.
 */
export class LiveRun {
  private capturing = false;
  private encoding = false;
  private lastFrame = 0;
  private readonly offscreen = document.createElement('canvas');

  private viewer: { canvas: HTMLCanvasElement; banner: HTMLElement } | null = null;
  private decoding = false;
  private restoreMonitors: (() => void) | null = null;

  constructor(
    private readonly host: VmHost,
    private readonly stageWrap: HTMLElement,
    /** True when the connection can take another frame without falling behind. */
    private readonly canSend: (queuedBytes: number) => boolean,
    private readonly send: (frame: Uint8Array<ArrayBuffer>) => void,
  ) {
    this.offscreen.width = FRAME_WIDTH;
    this.offscreen.height = FRAME_HEIGHT;
    this.installCapture();
  }

  private get runtime(): any {
    return this.host.vm.runtime;
  }

  // ---- runner ---------------------------------------------------------------

  /** The VM draws the stage after every step. Copy it right then, while the picture is still there. */
  private installCapture(): void {
    const renderer = this.runtime.renderer;
    if (!renderer) return;
    const draw = renderer.draw;
    renderer.draw = (...args: unknown[]) => {
      const result = draw.apply(renderer, args);
      if (this.capturing) this.captureFrame(renderer.canvas);
      return result;
    };
  }

  startCapture(): void {
    this.capturing = true;
    this.lastFrame = 0;
    this.runtime.requestRedraw();
  }

  stopCapture(): void {
    this.capturing = false;
  }

  private captureFrame(source: HTMLCanvasElement): void {
    const now = performance.now();
    if (this.encoding || now - this.lastFrame < FRAME_INTERVAL_MS) return;
    if (!this.canSend(0)) return;
    this.lastFrame = now;
    const ctx = this.offscreen.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(source, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    const monitors = this.monitorValues();

    this.encoding = true;
    this.offscreen.toBlob(
      async (blob) => {
        try {
          if (!blob || !this.capturing) return;
          const jpeg = new Uint8Array(await blob.arrayBuffer());
          let json = new TextEncoder().encode(JSON.stringify({ m: monitors }));
          if (json.length > 0xffff) json = new TextEncoder().encode('{"m":{}}');
          const frame = new Uint8Array(3 + json.length + jpeg.length);
          frame[0] = FRAME_JPEG;
          frame[1] = json.length >> 8;
          frame[2] = json.length & 0xff;
          frame.set(json, 3);
          frame.set(jpeg, 3 + json.length);
          if (this.canSend(frame.length)) this.send(frame);
        } finally {
          this.encoding = false;
        }
      },
      'image/jpeg',
      0.65,
    );
  }

  /** What the monitors on the stage currently say, so viewers can show live values. */
  private monitorValues(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const monitor of this.runtime.getMonitorState().valueSeq().toArray()) {
      if (monitor.get('visible')) values[monitor.get('id')] = monitor.get('value');
    }
    return JSON.stringify(values).length > MAX_MONITOR_JSON ? {} : values;
  }

  static get maxBuffered(): number {
    return MAX_BUFFERED_BYTES;
  }

  // ---- viewer ---------------------------------------------------------------

  showViewer(runnerName: string): void {
    this.hideViewer();
    const canvas = document.createElement('canvas');
    canvas.className = 'cw-stream';
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const banner = document.createElement('div');
    banner.className = 'cw-stream-banner';
    banner.textContent = `Watching ${runnerName}'s test run`;
    // Under the monitors so they still draw on top of the picture.
    this.stageWrap.insertBefore(canvas, this.stageWrap.querySelector('.monitors'));
    this.stageWrap.appendChild(banner);
    this.viewer = { canvas, banner };

    // The runner's monitor values arrive with the pictures, so stop this computer from overwriting them.
    const original = this.runtime._pushMonitors;
    this.runtime._pushMonitors = () => {};
    this.restoreMonitors = () => {
      this.runtime._pushMonitors = original;
    };
  }

  hideViewer(): void {
    this.viewer?.canvas.remove();
    this.viewer?.banner.remove();
    this.viewer = null;
    this.restoreMonitors?.();
    this.restoreMonitors = null;
  }

  get viewing(): boolean {
    return this.viewer !== null;
  }

  async showFrame(data: ArrayBuffer): Promise<void> {
    const viewer = this.viewer;
    if (!viewer || this.decoding || data.byteLength < 4) return;
    const view = new DataView(data);
    if (view.getUint8(0) !== FRAME_JPEG) return;
    const jsonLength = view.getUint16(1);
    if (3 + jsonLength >= data.byteLength) return;

    this.decoding = true;
    try {
      try {
        const { m } = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 3, jsonLength)));
        for (const [id, value] of Object.entries(m ?? {})) {
          this.runtime.requestUpdateMonitor(ImmutableMap({ id, value } as any));
        }
      } catch {
        /* bad monitor values are not worth dropping the picture for */
      }
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data, 3 + jsonLength)], { type: 'image/jpeg' }));
      if (this.viewer === viewer) {
        (viewer.canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      }
      bitmap.close();
    } catch {
      /* a broken frame is just skipped */
    } finally {
      this.decoding = false;
    }
  }
}
