/**
 * Sends mouse and keyboard input to the VM so "when key pressed", "when this sprite clicked",
 * "mouse x", "key pressed?" and similar blocks work. scratch-gui does the same in its stage code.
 */

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

export function attachStageInput(canvas: HTMLCanvasElement, vm: any): void {
  const mouseData = (event: MouseEvent, extra: Record<string, unknown> = {}) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      canvasWidth: rect.width,
      canvasHeight: rect.height,
      ...extra,
    };
  };

  canvas.addEventListener('mousemove', (e) => vm.postIOData('mouse', mouseData(e)));
  canvas.addEventListener('mousedown', (e) => vm.postIOData('mouse', mouseData(e, { isDown: true })));
  // mouseup on the window so releasing outside the stage still counts.
  window.addEventListener('mouseup', (e) => vm.postIOData('mouse', mouseData(e, { isDown: false })));

  const sendKey = (e: KeyboardEvent, isDown: boolean) => {
    if (isTypingTarget(e.target)) return;
    // Only plain keys that Scratch knows; don't swallow browser/app shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    vm.postIOData('keyboard', { key: e.key, isDown });
  };
  document.addEventListener('keydown', (e) => sendKey(e, true));
  document.addEventListener('keyup', (e) => sendKey(e, false));
}
