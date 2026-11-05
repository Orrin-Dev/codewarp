import { VmHost } from './vmHost';
import { BlocksEditor } from './blocksEditor';

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

function boot(): void {
  setStatus('Creating VM…');
  const host = new VmHost($<HTMLCanvasElement>('stage'));

  setStatus('Creating blocks editor…');
  const editor = new BlocksEditor($('blocks-host'), host.vm);

  // ---- Sprite list ------------------------------------------------------

  const spriteList = $('sprite-list');

  host.vm.addListener(
      'targetsUpdate',
      (data: { targetList: { id: string; name: string; isStage: boolean }[]; editingTarget: string }) => {
        spriteList.replaceChildren();
        for (const t of data.targetList) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = t.name;
          if (t.id === data.editingTarget) btn.classList.add('active');
          btn.addEventListener('click', () => host.vm.setEditingTarget(t.id));
          spriteList.appendChild(btn);
        }
      },
  );

  // Experimental: adds an empty sprite (no costume yet; costume editing comes later).
  $('btn-add-sprite').addEventListener('click', async () => {
    const count = host.vm.runtime.targets.filter((t: any) => !t.isStage).length;
    const sprite = {
      name: `Sprite${count + 1}`,
      isStage: false,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [],
      sounds: [],
      volume: 100,
      layerOrder: count + 1,
      visible: true,
      x: 0,
      y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: 'all around',
    };
    try {
      await host.vm.addSprite(JSON.stringify(sprite));
    } catch (error) {
      console.error(error);
      setStatus('Could not add sprite (needs a costume asset in this build)');
    }
  });

  // ---- Project open / save / new ---------------------------------------

  let projectName = 'project.sb3';

  function pickFileInBrowser(): Promise<{ name: string; data: Uint8Array } | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.sb3';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        resolve(file ? { name: file.name, data: new Uint8Array(await file.arrayBuffer()) } : null);
      });
      input.click();
    });
  }

  function downloadInBrowser(name: string, data: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/x.scratch.sb3' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  $('btn-new').addEventListener('click', async () => {
    await host.newProject();
    projectName = 'project.sb3';
    setStatus('New project');
  });

  $('btn-open').addEventListener('click', async () => {
    const picked = window.codewarp ? await window.codewarp.openProject() : await pickFileInBrowser();
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

  $('btn-flag').addEventListener('click', () => host.greenFlag());
  $('btn-stop').addEventListener('click', () => host.stopAll());

  // ---- Mode toggle (text mode is a read-only preview for now) -----------

  const blocksHost = $('blocks-host');
  const textHost = $<HTMLTextAreaElement>('text-host');
  const modeBlocks = $('mode-blocks');
  const modeText = $('mode-text');

  function showBlocks(): void {
    textHost.hidden = true;
    blocksHost.hidden = false;
    modeBlocks.classList.add('active');
    modeText.classList.remove('active');
    editor.resize();
  }

  function showText(): void {
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