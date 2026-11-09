import { confirmDialog } from './dialogs';

/*
 * Shows what the updater is doing: a progress card while a new version downloads, a themed prompt when it
 * is ready to install, and a "installing" screen while the system asks for permission and replaces the app.
 */

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

export function installUpdateUi(): void {
  const bridge = window.codewarp;
  if (!bridge?.onUpdateEvent) return;

  // ---- progress card (bottom right) ----
  const card = document.createElement('div');
  card.className = 'cw-update-card';
  card.hidden = true;
  const title = document.createElement('div');
  title.className = 'cw-update-title';
  const track = document.createElement('div');
  track.className = 'cw-progress';
  const fill = document.createElement('div');
  fill.className = 'cw-progress-fill';
  track.appendChild(fill);
  const detail = document.createElement('div');
  detail.className = 'cw-update-detail';
  const restartButton = document.createElement('button');
  restartButton.type = 'button';
  restartButton.className = 'active';
  restartButton.textContent = 'Restart to update';
  restartButton.hidden = true;
  restartButton.addEventListener('click', () => void bridge.installUpdate());
  card.append(title, track, detail, restartButton);
  document.body.appendChild(card);

  // ---- the install screen ----
  let overlay: HTMLElement | null = null;
  let promptOpen = false;

  const closeOverlay = (): void => {
    overlay?.remove();
    overlay = null;
  };

  const showInstalling = (message: string, spinner: boolean): HTMLElement => {
    closeOverlay();
    overlay = document.createElement('div');
    overlay.className = 'cw-modal-overlay';
    const box = document.createElement('div');
    box.className = 'cw-modal';
    const heading = document.createElement('h2');
    heading.textContent = 'Updating Codewarp';
    const text = document.createElement('p');
    text.textContent = message;
    box.append(heading, text);
    if (spinner) {
      const bar = document.createElement('div');
      bar.className = 'cw-progress cw-progress-busy';
      bar.appendChild(document.createElement('div')).className = 'cw-progress-fill';
      box.appendChild(bar);
    }
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return box;
  };

  const askRestart = async (version: string): Promise<void> => {
    if (promptOpen || overlay) return;
    promptOpen = true;
    const restart = await confirmDialog({
      title: 'Update ready',
      message: `Codewarp ${version} has been downloaded. Restart now to install it.`,
      confirmText: 'Restart now',
      cancelText: 'Later',
    });
    promptOpen = false;
    if (restart) {
      void bridge.installUpdate();
    } else {
      // "Later": keep a small reminder in the corner so the update is never lost.
      card.hidden = false;
      title.textContent = `Codewarp ${version} is ready`;
      track.hidden = true;
      detail.textContent = 'It installs when you restart.';
      restartButton.hidden = false;
    }
  };

  const handle = (event: UpdateEvent): void => {
    switch (event.type) {
      case 'available':
        card.hidden = false;
        track.hidden = false;
        restartButton.hidden = true;
        title.textContent = `Downloading Codewarp ${event.version ?? ''}…`;
        fill.style.width = '0%';
        detail.textContent = 'Starting…';
        break;
      case 'progress': {
        card.hidden = false;
        const percent = Math.max(0, Math.min(100, event.percent ?? 0));
        fill.style.width = `${percent}%`;
        if (!title.textContent) title.textContent = 'Downloading update…';
        detail.textContent = `${percent.toFixed(0)}%  ·  ${mb(event.transferred ?? 0)} of ${mb(event.total ?? 0)}  ·  ${mb(event.bytesPerSecond ?? 0)}/s`;
        break;
      }
      case 'ready':
        card.hidden = true;
        title.textContent = '';
        void askRestart(event.version ?? 'update');
        break;
      case 'installing':
        card.hidden = true;
        showInstalling('Installing the update. Your system may ask for your password. Codewarp restarts by itself when it is done.', true);
        break;
      case 'installed':
        showInstalling('Done. Restarting…', true);
        break;
      case 'install-failed': {
        const box = showInstalling(event.message ?? 'The update could not be installed.', false);
        const buttons = document.createElement('div');
        buttons.className = 'cw-modal-buttons';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        close.addEventListener('click', closeOverlay);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'active';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => {
          closeOverlay();
          void bridge.installUpdate();
        });
        buttons.append(close, retry);
        box.appendChild(buttons);
        break;
      }
      case 'idle':
        if (!restartButton.hidden) break; // keep the "ready" reminder
        card.hidden = true;
        title.textContent = '';
        break;
    }
  };

  bridge.onUpdateEvent(handle);
  // A window opened after the download finished still needs to hear about it.
  void bridge.getUpdateState().then((state) => {
    if (state?.phase === 'ready') handle({ type: 'ready', version: state.version });
    else if (state?.phase === 'progress' || state?.phase === 'available') handle({ ...state, type: state.phase });
  });
}
