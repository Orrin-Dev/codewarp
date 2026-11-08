import { STAGE_TOOLBOX_XML, TOOLBOX_XML } from './toolbox';
import { installProjectMenus } from './menus';
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

/** What this person is doing in the editor besides editing: selecting a block, or dragging one. */
export type Presence =
  | { kind: 'select'; target: string; block: string }
  | { kind: 'drag'; target: string; block: string; dx: number; dy: number };

const DRAG_SEND_MS = 50;
/** How long a block that someone just dropped stays where their drag ended, waiting for the move itself to arrive. */
const DROP_SETTLE_MS = 300;

/** Edits that can change what the palette shows (variables, and custom block definitions). */
const PALETTE_PATTERN = /procedures_(definition|prototype)/;

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
  private readonly presenceListeners = new Set<(presence: Presence) => void>();

  // Skipping needless reloads: what is on screen, and whether the user changed it since.
  private loadedXml = '';
  private loadedTargetId = '';
  private workspaceDirty = true;

  // Other people's selections and drags, drawn on blocks.
  private readonly remoteSelected = new Map<string, string>();
  private readonly remoteDragging = new Map<string, { block: string; timer?: number }>();
  private pointerStart: { x: number; y: number } | null = null;
  private draggingBlock = '';
  private lastDragSent = 0;

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
    installProjectMenus(ScratchBlocks, this.vm);
    this.workspace = ScratchBlocks.inject(host, {
      media: './blocks-media/',
      toolbox: TOOLBOX_XML,
      zoom: { controls: true, wheel: true, startScale: 0.675 },
      grid: { spacing: 40, length: 2, colour: '#2e3340' },
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
      if (event?.type !== 'ui') this.workspaceDirty = true;
      if (REFRESH_EVENTS.has(event?.type) && this.affectsPalette(event)) this.scheduleToolboxRefresh();
      if (event?.type === 'ui' && event.element === 'selected') this.emitPresence({ kind: 'select', target: this.targetName(), block: String(event.newValue ?? '') });
    });
    this.watchDrags();

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

  // ---- presence: selecting and dragging blocks --------------------------------------------

  private targetName(): string {
    return this.vm.editingTarget?.getName?.() ?? '';
  }

  /** Be told when the user selects or drags a block. Returns a function that stops listening. */
  onPresence(listener: (presence: Presence) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  private emitPresence(presence: Presence): void {
    if (this.presenceListeners.size === 0 || !presence.target) return;
    for (const listener of this.presenceListeners) listener(presence);
  }

  /** Notice when the user is dragging a block (it gets the class blocklyDragging) and report how far it has moved. */
  private watchDrags(): void {
    const endDrag = () => {
      if (this.draggingBlock) this.emitPresence({ kind: 'drag', target: this.targetName(), block: '', dx: 0, dy: 0 });
      this.draggingBlock = '';
      this.pointerStart = null;
    };
    this.host.addEventListener('pointerdown', (e) => (this.pointerStart = { x: e.clientX, y: e.clientY }), true);
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
    window.addEventListener(
      'pointermove',
      (e) => {
        if (!this.pointerStart || this.presenceListeners.size === 0) return;
        const selected = ScratchBlocks.selected;
        const dragging = Boolean(selected?.getSvgRoot?.()?.classList?.contains('blocklyDragging'));
        if (!dragging) {
          if (this.draggingBlock) endDrag();
          return;
        }
        const now = performance.now();
        if (selected.id === this.draggingBlock && now - this.lastDragSent < DRAG_SEND_MS) return;
        this.draggingBlock = selected.id;
        this.lastDragSent = now;
        const scale = this.workspace.scale || 1;
        this.emitPresence({
          kind: 'drag',
          target: this.targetName(),
          block: selected.id,
          dx: (e.clientX - this.pointerStart.x) / scale,
          dy: (e.clientY - this.pointerStart.y) / scale,
        });
      },
      true,
    );
  }

  private remoteBlock(target: string, id: string): any | null {
    if (!id || this.targetName() !== target) return null;
    return this.workspace.getBlockById(id) ?? null;
  }

  /** Outline the block somebody else has selected, in their colour. */
  showRemoteSelect(peer: string, color: string, target: string, id: string): void {
    this.clearRemoteSelect(peer);
    const block = this.remoteBlock(target, id);
    const root: SVGElement | undefined = block?.getSvgRoot?.();
    if (!root) return;
    root.classList.add('cw-remote-selected');
    root.style.setProperty('--peer-color', color);
    this.remoteSelected.set(peer, id);
  }

  private clearRemoteSelect(peer: string): void {
    const id = this.remoteSelected.get(peer);
    if (!id) return;
    this.remoteSelected.delete(peer);
    const root: SVGElement | undefined = this.workspace.getBlockById(id)?.getSvgRoot?.();
    root?.classList.remove('cw-remote-selected');
  }

  /** Move a block on screen the way somebody else is dragging it. The real move arrives when they let go. */
  showRemoteDrag(peer: string, color: string, target: string, id: string, dx: number, dy: number): void {
    const state = this.remoteDragging.get(peer);
    if (!id) {
      if (state) this.finishRemoteDrag(peer);
      return;
    }
    if (state && state.block !== id) this.finishRemoteDrag(peer, true);
    const block = this.remoteBlock(target, id);
    const root: SVGElement | undefined = block?.getSvgRoot?.();
    // Only loose blocks can follow the mouse. A block still inside a stack waits until it has been pulled out.
    if (!block || !root || block.getParent()) return;
    const current = this.remoteDragging.get(peer);
    if (current?.timer) window.clearTimeout(current.timer);
    this.remoteDragging.set(peer, { block: id });
    const base = block.getRelativeToSurfaceXY();
    root.classList.add('cw-remote-drag');
    root.style.setProperty('--peer-color', color);
    root.setAttribute('transform', `translate(${base.x + dx},${base.y + dy})`);
  }

  private finishRemoteDrag(peer: string, now = false): void {
    const state = this.remoteDragging.get(peer);
    if (!state) return;
    const settle = () => {
      this.remoteDragging.delete(peer);
      const block = this.workspace.getBlockById(state.block);
      const root: SVGElement | undefined = block?.getSvgRoot?.();
      if (!block || !root) return;
      root.classList.remove('cw-remote-drag');
      // If the move already arrived Blockly has placed the block; otherwise put it back where it really is.
      if (!block.getParent()) {
        const xy = block.getRelativeToSurfaceXY();
        root.setAttribute('transform', `translate(${xy.x},${xy.y})`);
      }
    };
    if (now) settle();
    else state.timer = window.setTimeout(settle, DROP_SETTLE_MS);
  }

  /** Forget everything drawn for somebody who left or stopped sharing. */
  clearRemote(peer: string): void {
    this.clearRemoteSelect(peer);
    if (this.remoteDragging.has(peer)) this.finishRemoteDrag(peer, true);
  }

  clearAllRemote(): void {
    for (const peer of [...this.remoteSelected.keys(), ...this.remoteDragging.keys()]) this.clearRemote(peer);
  }

  /** Does this edit change what the palette shows? Ordinary blocks do not; variables and custom blocks do. */
  private affectsPalette(event: any): boolean {
    switch (event?.type) {
      case 'var_create':
      case 'var_delete':
      case 'var_rename':
        return true;
      case 'create':
        return PALETTE_PATTERN.test(String(event.xml?.outerHTML ?? ''));
      case 'delete':
        return PALETTE_PATTERN.test(String(event.oldXml?.outerHTML ?? ''));
      case 'change': {
        const type: string | undefined = this.workspace.getBlockById(event.blockId)?.type;
        return Boolean(type && type.startsWith('procedures_'));
      }
      default:
        return false;
    }
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
      // Deleting a used variable asks "are you sure?". The person who deleted it already answered,
      // so a remote delete must not ask everyone else.
      const originalConfirm = ScratchBlocks.confirm;
      ScratchBlocks.confirm = (_message: string, callback: (ok: boolean) => void) => callback(true);
      try {
        event.run(true);
      } catch (error) {
        // Happens when two people touched the same block at once, e.g. deleting something already gone.
        console.warn('Remote edit did not apply to the workspace', edit.event, error);
      } finally {
        ScratchBlocks.confirm = originalConfirm;
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
    const eventType = String(edit.event.type);
    const text = String(edit.event.xml ?? edit.event.oldXml ?? '');
    const blockType = edit.event.blockId ? this.workspace.getBlockById(String(edit.event.blockId))?.type : '';
    if (eventType.startsWith('var_') || PALETTE_PATTERN.test(text) || String(blockType ?? '').startsWith('procedures_')) {
      this.scheduleToolboxRefresh();
    }
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
  private stageToolbox = false;

  private scheduleToolboxRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      // Rebuilding the palette is slow, so never do it while a block is being dragged: try again right after.
      if (this.workspace.isDragging?.()) {
        this.scheduleToolboxRefresh();
        return;
      }
      const run = () => {
        try {
          if (typeof this.workspace.refreshToolboxSelection_ === 'function') {
            this.workspace.refreshToolboxSelection_();
          }
        } catch (error) {
          console.warn('Toolbox refresh failed', error);
        }
      };
      const idle = (window as any).requestIdleCallback as ((cb: () => void, opts: { timeout: number }) => void) | undefined;
      if (idle) idle(run, { timeout: 1000 });
      else run();
    }, 250);
  }

  /** The stage gets a smaller palette than a sprite (no motion, no talking, no touching...). */
  private syncToolboxToTarget(): void {
    const stage = Boolean(this.vm.editingTarget?.isStage);
    if (stage === this.stageToolbox) return;
    this.stageToolbox = stage;
    try {
      this.workspace.updateToolbox(stage ? STAGE_TOOLBOX_XML : TOOLBOX_XML);
    } catch (error) {
      console.warn('Could not switch the block palette', error);
    }
  }

  private onWorkspaceUpdate(data: { xml: string }): void {
    this.syncToolboxToTarget();
    const targetId: string = this.vm.editingTarget?.id ?? '';
    // The VM announces the same sprite again after many things (a collaborator's change elsewhere, switching
    // tabs...). Rebuilding hundreds of blocks for nothing is the slowest thing the editor does, so skip it.
    if (!this.workspaceDirty && targetId === this.loadedTargetId && data.xml === this.loadedXml) return;

    const started = performance.now();
    this.clearAllRemote();
    // Detach the VM listener while loading so loading doesn't echo back as edits.
    this.workspace.removeChangeListener(this.vm.blockListener);
    // Switch events off while loading: reloading a sprite is not an edit, and collaborators must not see it as one.
    ScratchBlocks.Events.disable();
    // Measuring text is the expensive part of drawing a block. Remember the width of each string while loading,
    // because a big script repeats the same few words (move, steps, turn, wait...) hundreds of times.
    ScratchBlocks.Field?.startCache?.();
    try {
      const dom = ScratchBlocks.Xml.textToDom(data.xml);
      ScratchBlocks.Xml.clearWorkspaceAndLoadFromXml(dom, this.workspace);
      this.loadedXml = data.xml;
      this.loadedTargetId = targetId;
      this.workspaceDirty = false;
    } catch (error) {
      console.error('Failed to load workspace XML', error);
    } finally {
      ScratchBlocks.Field?.stopCache?.();
      ScratchBlocks.Events.enable();
    }
    this.workspace.addChangeListener(this.vm.blockListener);
    const blocks = this.workspace.getAllBlocks?.().length ?? 0;
    if (blocks > 100) console.info(`[blocks] opened ${blocks} blocks in ${Math.round(performance.now() - started)} ms`);
  }

  /** XML of the whole stack the selected block belongs to (without ids), for the backpack. */
  selectedStackXml(): string | null {
    const selected = ScratchBlocks.selected;
    if (!selected || !selected.getRootBlock) return null;
    try {
      const dom = ScratchBlocks.Xml.blockToDom(selected.getRootBlock());
      dom.removeAttribute('x');
      dom.removeAttribute('y');
      for (const node of Array.from(dom.querySelectorAll('block, shadow')) as Element[]) node.removeAttribute('id');
      dom.removeAttribute('id');
      return ScratchBlocks.Xml.domToText(dom);
    } catch (error) {
      console.error('Could not read the selected blocks', error);
      return null;
    }
  }

  /** Put a stack saved from the backpack into the workspace, near the top left of what is visible. */
  insertStackXml(xml: string): void {
    const dom = ScratchBlocks.Xml.textToDom(`<xml>${xml}</xml>`).firstElementChild;
    if (!dom) return;
    const block = ScratchBlocks.Xml.domToBlock(dom, this.workspace);
    const metrics = this.workspace.getMetrics();
    const scale = this.workspace.scale || 1;
    block.moveBy((metrics.viewLeft + 40) / scale, (metrics.viewTop + 40) / scale);
    block.select?.();
  }

  /** Call after the host element changes size or becomes visible again. */
  resize(): void {
    ScratchBlocks.svgResize(this.workspace);
  }
}
