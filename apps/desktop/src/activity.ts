/*
 * Progress cards for anything that takes a moment (opening or saving a project, joining a room, adding
 * a sprite). They stack in the bottom-right corner, together with the update card, and use the same look as the update progress card.
 * Pass a fraction (0 to 1) to fill the bar; pass null for the sliding "busy" bar.
 */

export interface Activity {
  /** Update the bar (fraction 0..1, or null while the length is unknown) and optionally the detail text. */
  set(fraction: number | null, detail?: string): void;
  /** Remove the card. Safe to call more than once. */
  done(): void;
}

let container: HTMLElement | null = null;

export function activityHost(): HTMLElement {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'cw-activity';
    document.body.appendChild(container);
  }
  return container;
}

export function startActivity(label: string): Activity {
  const card = document.createElement('div');
  card.className = 'cw-update-card cw-activity-card';
  const title = document.createElement('div');
  title.className = 'cw-update-title';
  title.textContent = label;
  const track = document.createElement('div');
  track.className = 'cw-progress cw-progress-busy';
  const fill = document.createElement('div');
  fill.className = 'cw-progress-fill';
  track.appendChild(fill);
  const detail = document.createElement('div');
  detail.className = 'cw-update-detail';
  detail.hidden = true;
  card.append(title, track, detail);
  activityHost().appendChild(card);

  let finished = false;
  return {
    set(fraction, text) {
      if (finished) return;
      if (fraction === null) {
        track.classList.add('cw-progress-busy');
        fill.style.width = '';
      } else {
        track.classList.remove('cw-progress-busy');
        fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      }
      if (text !== undefined) {
        detail.textContent = text;
        detail.hidden = !text;
      }
    },
    done() {
      if (finished) return;
      finished = true;
      card.remove();
    },
  };
}

/** Run a task with a progress card that is always removed afterwards, even if the task throws. */
export async function withActivity<T>(label: string, task: (activity: Activity) => Promise<T>): Promise<T> {
  const activity = startActivity(label);
  try {
    return await task(activity);
  } finally {
    activity.done();
  }
}
