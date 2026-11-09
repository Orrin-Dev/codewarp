/*
 * Themed replacements for the browser's alert() and confirm(). Every popup in Codewarp goes through
 * here (or prompt.ts / customBlock.ts), so nothing uses the plain system look. The only system windows
 * left are the operating system's own file pickers and password prompt.
 */

export interface DialogOptions {
  title: string;
  message?: string;
  confirmText?: string;
  /** Pass null for a message with a single button. */
  cancelText?: string | null;
  /** Colour the confirm button as a warning (for deleting things). */
  danger?: boolean;
}

export function confirmDialog(options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cw-modal-overlay';
    const dialog = document.createElement('form');
    dialog.className = 'cw-modal';

    const title = document.createElement('h2');
    title.textContent = options.title;
    dialog.appendChild(title);
    if (options.message) {
      const message = document.createElement('p');
      message.textContent = options.message;
      dialog.appendChild(message);
    }

    const buttons = document.createElement('div');
    buttons.className = 'cw-modal-buttons';
    const finish = (result: boolean): void => {
      overlay.remove();
      resolve(result);
    };
    if (options.cancelText !== null) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = options.cancelText ?? 'Cancel';
      cancel.addEventListener('click', () => finish(false));
      buttons.appendChild(cancel);
    }
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = options.danger ? 'cw-danger' : 'active';
    ok.textContent = options.confirmText ?? 'OK';
    buttons.appendChild(ok);
    dialog.appendChild(buttons);

    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });
    // Keep keystrokes away from Blockly's global shortcuts.
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
    });
    dialog.addEventListener('keyup', (e) => e.stopPropagation());
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay && options.cancelText !== null) finish(false);
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    window.setTimeout(() => ok.focus(), 30);
  });
}

/** A themed alert: one button. */
export async function messageDialog(title: string, message?: string): Promise<void> {
  await confirmDialog({ title, message, cancelText: null, confirmText: 'OK' });
}
