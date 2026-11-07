import { TOOLBOX_XML } from './toolbox';
import { showPrompt } from './prompt';
import { showMakeBlock } from './customBlock';

// Workspace event types that can change what the dynamic palette categories should show.
const REFRESH_EVENTS = new Set(['create', 'delete', 'change', 'var_create', 'var_delete', 'var_rename']);

// Workspace edits that collaborators need to see. UI events (selection, scrolling, drags in progress) stay local.
const SYNC_EVENTS = new Set([
  'create', 'delete', 'change', 'move',
  'var_create', 'var_delete', 'var_rename',
  'comment_create', 'comment_change', 'comment_move', 'comment_delete',
]);

/** A workspace edit in a form that can be sent to other people. */
export interface LocalEdit {
  /** Sprite name ("Stage" for the stage). */
  target: string;
  event: Record<string, unknown>;
}

// Assigned in the BlocksEditor constructor (not at import time) so failures show in the status bar.
let ScratchBlocks: any;

function resolveBlocks(): any {
  // The <script> tags in index.html define the global `Blockly`.
  const blockly = (window as any).Blockly;
  if (!blockly || typeof blockly.inject !== 'function') {
    throw new Error(
      'scratch-blocks did not load: window.Blockly is missing. Check the Network tab for 404s on /scratch-blocks/*.js',
    );
  }
  return blockly;
}

/**
 * Wraps a scratch-blocks workspace and keeps it in sync with scratch-vm.
 * The wiring mirrors scratch-gui's blocks.jsx: workspace events go to the VM's
 * listeners, and the VM's 'workspaceUpdate' event reloads the workspace XML.
 */
export class BlocksEditor {
  private workspace: any;
  private readonly editListeners = new Set<(edit: LocalEdit) => void>();

  constructor(private readonly host: HTMLElement, private readonly vm: any) {
    ScratchBlocks = resolveBlocks();
    // Electron has no window.prompt, so use our own dialog for "Make a Variable" etc.
    ScratchBlocks.prompt = showPrompt;
    // "Make a Block" and right-click > Edit on custom blocks call this; scratch-blocks has no UI for it.
    ScratchBlocks.Procedures.externalProcedureDefCallback = showMakeBlock;
    // scratch-blocks ships getCheckboxState as a stub that always answers "unchecked" and expects the
    // host app to replace it. Without this, every palette rebuild draws the variable checkboxes off
    // even though the VM is showing those monitors. The VM is the source of truth.
    ScratchBlocks.VerticalFlyout.getCheckboxState = (blockId: string): boolean => {
      const monitored = this.vm.runtime.monitorBlocks.getBlock(blockId);
      return monitored ? Boolean(monitored.isMonitored) : false;
    };
    this.workspace = ScratchBlocks.inject(host, {
      media: './blocks-media/',
      toolbox: TOOLBOX_XML,
      zoom: { controls: true, wheel: true, startScale: 0.675 },
      grid: { spacing: 40, length: 2, colour: '#ddd' },
      comments: true,
      collapse: false,
      sounds: false,
    });

    this.workspace.addChangeListener(this.vm.blockListener);

    const flyoutWorkspace = this.workspace.getFlyout().getWorkspace();
    flyoutWorkspace.addChangeListener(this.vm.flyoutBlockListener);
    flyoutWorkspace.addChangeListener(this.vm.monitorBlockListener);

    this.vm.addListener('workspaceUpdate', (data: { xml: string }) => this.onWorkspaceUpdate(data));
    window.addEventListener('resize', () => this.resize());

    // Highlight scripts and blocks while they run (clicking a block runs its stack).
    this.vm.addListener('SCRIPT_GLOW_ON', (data: { id: string }) => this.workspace.glowStack(data.id, true));
    this.vm.addListener('SCRIPT_GLOW_OFF', (data: { id: string }) => this.workspace.glowStack(data.id, false));
    this.vm.addListener('BLOCK_GLOW_ON', (data: { id: string }) => this.workspace.glowBlock(data.id, true));
    this.vm.addListener('BLOCK_GLOW_OFF', (data: { id: string }) => this.workspace.glowBlock(data.id, false));

    // The palette's Variables and My Blocks categories are built dynamically. Rebuild the open
    // category when blocks, variables or custom blocks change, or new entries only show up after
    // switching categories.
    this.workspace.addChangeListener((event: any) => {
      if (REFRESH_EVENTS.has(event?.type)) this.scheduleToolboxRefresh();
    });

    // The checkboxes in the palette show which monitors are on. Redraw when that changes, whoever changed it.
    let visibleMonitors = '';
    this.vm.addListener('MONITORS_UPDATE', (monitors: any) => {
      const now: string = monitors
        .valueSeq()
        .filter((m: any) => m.get('visible'))
        .map((m: any) => m.get('id'))
        .toArray()
        .sort()
        .join(',');
      if (now !== visibleMonitors) {
        visibleMonitors = now;
        this.scheduleToolboxRefresh();
      }
    });

    // Report the user's own edits (for real-time collaboration). Edits that other people made are applied
    // with events switched off, so they never come back through here.
    this.workspace.addChangeListener((event: any) => {
      if (this.editListeners.size === 0 || !SYNC_EVENTS.has(event?.type)) return;
      const target = this.vm.editingTarget;
      if (!target) return;
      let json: Record<string, unknown>;
      try {
        json = event.toJson();
      } catch {
        return;
      }
      const edit: LocalEdit = { target: target.getName(), event: json };
      for (const listener of this.editListeners) listener(edit);
    });
  }

  /** Be told about every edit the user makes. Returns a function that stops listening. */
  onLocalEdit(listener: (edit: LocalEdit) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  /**
   * Apply an edit somebody else made. It goes into the VM always, and into the visible workspace when
   * it belongs to the sprite being edited (or is a global variable change).
   */
  applyRemoteEdit(edit: LocalEdit): void {
    const vm = this.vm;
    const target = vm.runtime.targets.find((t: any) => t.isOriginal && t.getName() === edit.target);
    if (!target) return; // that sprite doesn't exist here (sprite add/delete is not synced yet)

    const type = String(edit.event.type);
    const isVar = type.startsWith('var_');
    const isLocalVar = isVar && Boolean(edit.event.isLocal);
    const editing = vm.editingTarget === target;

    let event: any;
    try {
      event = ScratchBlocks.Events.fromJson(edit.event, this.workspace);
    } catch (error) {
      console.warn('Ignoring unknown remote event', edit.event, error);
      return;
    }

    if (editing || (isVar && !isLocalVar)) {
      ScratchBlocks.Events.disable();
      try {
        event.run(true);
      } catch (error) {
        // Happens when two people touched the same block at once, e.g. deleting something already gone.
        console.warn('Remote edit did not apply to the workspace', edit.event, error);
      } finally {
        ScratchBlocks.Events.enable();
      }
    }

    try {
      if (isLocalVar && !editing) {
        // The VM resolves local variables through the editing target, so handle other sprites directly.
        if (type === 'var_create' && !target.lookupVariableById(String(edit.event.varId))) {
          target.createVariable(String(edit.event.varId), String(edit.event.varName), String(edit.event.varType));
        } else if (type === 'var_rename') {
          target.renameVariable(String(edit.event.varId), String(edit.event.newName));
        } else if (type === 'var_delete') {
          target.deleteVariable(String(edit.event.varId));
        }
      } else {
        target.blocks.blocklyListen(event);
      }
    } catch (error) {
      console.warn('Remote edit did not apply to the VM', edit.event, error);
    }
    this.scheduleToolboxRefresh();
  }

  /** Convert a mouse position on screen to workspace coordinates, or null if it isn't over the workspace. */
  clientToWorkspace(clientX: number, clientY: number): { x: number; y: number } | null {
    const ctm = this.workspace.getCanvas()?.getScreenCTM?.();
    if (!ctm) return null;
    const svg: SVGSVGElement = this.workspace.getParentSvg();
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  }

  /** Convert workspace coordinates to a position relative to the editor element. */
  workspaceToHost(x: number, y: number): { x: number; y: number } | null {
    const ctm = this.workspace.getCanvas()?.getScreenCTM?.();
    if (!ctm) return null;
    const svg: SVGSVGElement = this.workspace.getParentSvg();
    const point = svg.createSVGPoint();
    point.x = x;
    point.y = y;
    const screen = point.matrixTransform(ctm);
    const rect = this.host.getBoundingClientRect();
    return { x: screen.x - rect.left, y: screen.y - rect.top };
  }

  /** The element that holds the workspace (cursors are drawn on top of it). */
  get element(): HTMLElement {
    return this.host;
  }

  private refreshTimer: number | undefined;

  private scheduleToolboxRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      try {
        if (typeof this.workspace.refreshToolboxSelection_ === 'function') {
          this.workspace.refreshToolboxSelection_();
        }
      } catch (error) {
        console.warn('Toolbox refresh failed', error);
      }
    }, 50);
  }

  private onWorkspaceUpdate(data: { xml: string }): void {
    // Detach the VM listener while loading so loading doesn't echo back as edits.
    this.workspace.removeChangeListener(this.vm.blockListener);
    // Switch events off while loading: reloading a sprite is not an edit, and collaborators must not see it as one.
    ScratchBlocks.Events.disable();
    try {
      const dom = ScratchBlocks.Xml.textToDom(data.xml);
      ScratchBlocks.Xml.clearWorkspaceAndLoadFromXml(dom, this.workspace);
    } catch (error) {
      console.error('Failed to load workspace XML', error);
    } finally {
      ScratchBlocks.Events.enable();
    }
    this.workspace.addChangeListener(this.vm.blockListener);
  }

  /** Call after the host element changes size or becomes visible again. */
  resize(): void {
    ScratchBlocks.svgResize(this.workspace);
  }
}
