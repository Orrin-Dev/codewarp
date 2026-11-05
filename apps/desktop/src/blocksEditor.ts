import { TOOLBOX_XML } from './toolbox';
import { showPrompt } from './prompt';

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

  constructor(private readonly host: HTMLElement, private readonly vm: any) {
    ScratchBlocks = resolveBlocks();
    // Electron has no window.prompt, so use our own dialog for "Make a Variable" etc.
    ScratchBlocks.prompt = showPrompt;
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
  }

  private onWorkspaceUpdate(data: { xml: string }): void {
    // Detach the VM listener while loading so loading doesn't echo back as edits.
    this.workspace.removeChangeListener(this.vm.blockListener);
    try {
      const dom = ScratchBlocks.Xml.textToDom(data.xml);
      ScratchBlocks.Xml.clearWorkspaceAndLoadFromXml(dom, this.workspace);
    } catch (error) {
      console.error('Failed to load workspace XML', error);
    }
    this.workspace.addChangeListener(this.vm.blockListener);
  }

  /** Call after the host element changes size or becomes visible again. */
  resize(): void {
    ScratchBlocks.svgResize(this.workspace);
  }
}