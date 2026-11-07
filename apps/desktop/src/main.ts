import { spriteShapeSvg } from '@codewarp/core';
import { VmHost, type SpriteImage } from './vmHost';
import { BlocksEditor } from './blocksEditor';
import { SpritePanel } from './spritePanel';
import { MonitorOverlay } from './monitors';
import { attachStageInput } from './stageInput';
import { CostumesPanel } from './costumes';
import { SoundsPanel } from './sounds';
import { pickFile } from './files';
import { Collab } from './collab';
import { CollabUi } from './collabUi';
import { SettingsPanel } from './settingsPanel';
import { applySavedTheme } from './settings';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const statusEl = $('status');
const setStatus = (text: string) => {
  statusEl.textContent = text;
};

// Surface any error on screen instead of leaving the status stuck.
window.addEventListener('error', (e) => setStatus(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  setStatus(`Error: ${(e.reason && e.reason.message) || String(e.reason)}`),
);

function downloadInBrowser(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/x.scratch.sb3' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Read an image file and work out its format and pixel size. */
async function readSpriteImage(file: File): Promise<SpriteImage> {
  const lower = file.name.toLowerCase();
  const ext: SpriteImage['ext'] = lower.endsWith('.svg') ? 'svg' : lower.endsWith('.png') ? 'png' : 'jpg';
  if (!/\.(svg|png|jpe?g)$/.test(lower)) throw new Error('Use a .png, .jpg or .svg image');

  const data = new Uint8Array(await file.arrayBuffer());
  const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
  try {
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || 64, height: img.naturalHeight || 64 });
      img.onerror = () => reject(new Error(`Could not read ${file.name} as an image`));
      img.src = url;
    });
    return { data, ext, ...size };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Fill / outline pairs for new shape sprites, cycled so sprites are easy to tell apart.
const SHAPE_COLORS: [string, string][] = [
  ['#ff6680', '#c93a58'],
  ['#4c97ff', '#2b6bd0'],
  ['#59c059', '#2f8f2f'],
  ['#ffab19', '#c47a00'],
  ['#9966ff', '#6c3fd1'],
];

function boot(): void {
  applySavedTheme();
  setStatus('Creating VM…');
  const canvas = $<HTMLCanvasElement>('stage');
  const host = new VmHost(canvas);

  setStatus('Creating blocks editor…');
  const editor = new BlocksEditor($('blocks-host'), host.vm);

  new MonitorOverlay($('monitors'), host.vm);
  attachStageInput(canvas, host.vm);
  new SpritePanel($('sprite-list'), $('sprite-props'), host, (message) => setStatus(message));

  // ---- Collaboration -----------------------------------------------------

  let collabUi: CollabUi | null = null;
  const collab = new Collab(
    host,
    editor,
    {
      onChange: () => collabUi?.render(),
      onMessage: (text) => setStatus(text),
    },
    document.querySelector('.stage-wrap') as HTMLElement,
  );
  collabUi = new CollabUi(collab, $<HTMLButtonElement>('btn-collab'), $('people'), setStatus);

  // ---- Tabs: Code / Costumes / Sounds -----------------------------------

  const costumes = new CostumesPanel($('pane-costumes'), host, setStatus);
  const sounds = new SoundsPanel($('pane-sounds'), host, setStatus);
  new SettingsPanel($('pane-settings'));
  const tabs = {
    code: { tab: $('tab-code'), pane: $('pane-code') },
    costumes: { tab: $('tab-costumes'), pane: $('pane-costumes') },
    sounds: { tab: $('tab-sounds'), pane: $('pane-sounds') },
    settings: { tab: $('tab-settings'), pane: $('pane-settings') },
  };
  type TabName = keyof typeof tabs;
  function showTab(name: TabName): void {
    for (const [key, { tab, pane }] of Object.entries(tabs)) {
      tab.classList.toggle('active', key === name);
      pane.hidden = key !== name;
    }
    costumes.setActive(name === 'costumes');
    sounds.setActive(name === 'sounds');
    if (name === 'code') editor.resize();
  }
  (Object.keys(tabs) as TabName[]).forEach((name) =>
    tabs[name].tab.addEventListener('click', () => showTab(name)),
  );

  // ---- Sprites ---------------------------------------------------------

  const spriteCount = (): number =>
    host.vm.runtime.targets.filter((t: any) => !t.isStage && t.isOriginal).length;

  $('btn-add-sprite').addEventListener('click', async () => {
    const n = spriteCount();
    const [fill, stroke] = SHAPE_COLORS[n % SHAPE_COLORS.length];
    try {
      await host.addSpriteFromImage(`Sprite${n + 1}`, {
        data: new TextEncoder().encode(spriteShapeSvg(fill, stroke)),
        ext: 'svg',
        width: 64,
        height: 64,
      });
    } catch (error: any) {
      console.error(error);
      setStatus(`Could not add sprite: ${error?.message ?? error}`);
    }
  });

  $('btn-upload-sprite').addEventListener('click', async () => {
    const file = await pickFile('.png,.jpg,.jpeg,.svg');
    if (!file) return;
    try {
      const image = await readSpriteImage(file);
      const baseName = file.name.replace(/\.[^.]+$/, '') || `Sprite${spriteCount() + 1}`;
      await host.addSpriteFromImage(baseName, image);
      setStatus(`Added ${baseName}`);
    } catch (error: any) {
      console.error(error);
      setStatus(`Could not add sprite: ${error?.message ?? error}`);
    }
  });

  // ---- Project open / save / new ---------------------------------------

  let projectName = 'project.sb3';

  // Opening a different project while sharing one would leave everyone else out of step.
  const blockedByCollab = (): boolean => {
    if (collab.state === 'offline') return false;
    setStatus('Leave the collaboration room before creating or opening a project');
    return true;
  };

  $('btn-new').addEventListener('click', async () => {
    if (blockedByCollab()) return;
    await host.newProject();
    projectName = 'project.sb3';
    setStatus('New project');
  });

  $('btn-open').addEventListener('click', async () => {
    if (blockedByCollab()) return;
    let picked: { name: string; data: Uint8Array } | null;
    if (window.codewarp) {
      picked = await window.codewarp.openProject();
    } else {
      const file = await pickFile('.sb3');
      picked = file ? { name: file.name, data: new Uint8Array(await file.arrayBuffer()) } : null;
    }
    if (!picked) return;
    const buffer = picked.data.buffer.slice(
      picked.data.byteOffset,
      picked.data.byteOffset + picked.data.byteLength,
    ) as ArrayBuffer;
    try {
      await host.load(buffer);
      projectName = picked.name;
      setStatus(`Opened ${picked.name}`);
    } catch (error) {
      console.error(error);
      setStatus(`Failed to open ${picked.name}`);
    }
  });

  $('btn-save').addEventListener('click', async () => {
    const bytes = await host.saveSb3();
    if (window.codewarp) {
      const savedTo = await window.codewarp.saveProject(projectName, bytes);
      if (savedTo) setStatus(`Saved ${savedTo}`);
    } else {
      downloadInBrowser(projectName, bytes);
      setStatus(`Downloaded ${projectName}`);
    }
  });

  // ---- Run controls -----------------------------------------------------

  // In a collaboration room Run streams a live test to everyone; outside one it just runs.
  $('btn-flag').addEventListener('click', () => collab.run());
  $('btn-stop').addEventListener('click', () => collab.stop());

  // ---- Mode toggle (text mode is a read-only preview for now) -----------

  const blocksHost = $('blocks-host');
  const textHost = $<HTMLTextAreaElement>('text-host');
  const modeBlocks = $('mode-blocks');
  const modeText = $('mode-text');

  function showBlocks(): void {
    showTab('code');
    textHost.hidden = true;
    blocksHost.hidden = false;
    modeBlocks.classList.add('active');
    modeText.classList.remove('active');
    editor.resize();
  }

  function showText(): void {
    showTab('code');
    // Placeholder: the C#-style and Python-style printers will render here later.
    textHost.value = JSON.stringify(host.editingTargetJson(), null, 2);
    blocksHost.hidden = true;
    textHost.hidden = false;
    modeText.classList.add('active');
    modeBlocks.classList.remove('active');
  }

  modeBlocks.addEventListener('click', showBlocks);
  modeText.addEventListener('click', showText);

  // ---- Load the starting project ----------------------------------------

  setStatus('Loading project…');
  const hangTimer = window.setTimeout(
    () => setStatus('Project load is taking too long (open DevTools: Ctrl+Shift+I)'),
    8000,
  );

  host
    .newProject()
    .then(() => {
      window.clearTimeout(hangTimer);
      setStatus('Ready');
    })
    .catch((error) => {
      window.clearTimeout(hangTimer);
      console.error(error);
      setStatus(`Load failed: ${error?.message ?? error}`);
    });
}

try {
  boot();
} catch (error: any) {
  console.error(error);
  setStatus(`Startup failed: ${error?.message ?? error}`);
}
