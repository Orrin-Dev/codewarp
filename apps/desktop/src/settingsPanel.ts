import {
  customThemes,
  deleteCustomTheme,
  sameTheme,
  saveCustomTheme,
  DEFAULT_SERVER_URL,
  LOCAL_SERVER_URL,
  THEME_PRESETS,
  applyTheme,
  collabServerUrl,
  getFramerate,
  saveFramerate,
  getScratchSprites,
  saveScratchSprites,
  currentTheme,
  isValidServerUrl,
  resetTheme,
  saveServerUrl,
  saveTheme,
  testServer,
  type ThemeColors,
} from './settings';

const COLOR_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: 'accent', label: 'Accent' },
  { key: 'bg', label: 'Background' },
  { key: 'panel', label: 'Panels' },
  { key: 'text', label: 'Text' },
];

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** The Settings tab: colours and the collaboration server. */
export class SettingsPanel {
  private theme: ThemeColors = currentTheme();
  private readonly colorInputs = new Map<keyof ThemeColors, HTMLInputElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly onFramerate: (fps: number) => void = () => {},
    private readonly diagnostics: { text(): string; clear(): void } | null = null,
  ) {
    root.classList.add('cw-settings');
    const page = element('div', 'cw-settings-page');
    page.append(this.buildAppearance(), this.buildProject(), this.buildServer());
    if (this.diagnostics) page.append(this.buildDiagnostics(this.diagnostics));
    root.replaceChildren(page);
  }

  // ---- appearance ----

  private presetsBox = element('div', 'cw-presets');
  private themeMessage = element('p', 'cw-settings-message');

  private buildAppearance(): HTMLElement {
    const section = element('section', 'cw-settings-section');
    section.append(element('h2', '', 'Appearance'));
    section.append(
      element('p', 'cw-settings-hint', 'Pick a theme or change the colours yourself. Your choice is saved and used the next time you open Codewarp.'),
    );
    section.appendChild(this.presetsBox);
    this.renderPresets();

    const grid = element('div', 'cw-color-grid');
    for (const { key, label } of COLOR_FIELDS) {
      const row = element('label', 'cw-color-row');
      const input = element('input');
      input.type = 'color';
      input.value = this.theme[key];
      input.addEventListener('input', () => this.setTheme({ ...this.theme, [key]: input.value }, key));
      this.colorInputs.set(key, input);
      row.append(input, element('span', '', label));
      grid.appendChild(row);
    }
    section.appendChild(grid);

    // Save the current colours as a theme of your own.
    const saveRow = element('div', 'cw-settings-buttons');
    const nameInput = element('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Name for your theme';
    nameInput.maxLength = 24;
    const saveButton = element('button', '', 'Save as theme');
    saveButton.type = 'button';
    saveButton.addEventListener('click', () => {
      const saved = saveCustomTheme(nameInput.value, this.theme);
      if (!saved) {
        this.themeMessage.textContent = 'Enter a name that is not one of the built-in themes.';
        this.themeMessage.classList.add('cw-bad');
        return;
      }
      nameInput.value = '';
      this.themeMessage.textContent = `Saved "${saved}".`;
      this.themeMessage.classList.remove('cw-bad');
      this.renderPresets();
    });
    const reset = element('button', '', 'Reset colours');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      resetTheme();
      this.theme = currentTheme();
      this.syncInputs();
      this.renderPresets();
    });
    saveRow.append(nameInput, saveButton, reset);
    section.append(saveRow, this.themeMessage);
    return section;
  }

  /** The theme chips: built-in ones, then your own. The one in use is highlighted. */
  private renderPresets(): void {
    const chips: HTMLElement[] = [];
    const chip = (name: string, colors: ThemeColors, removable: boolean): HTMLElement => {
      const wrap = element('div', 'cw-preset-wrap');
      const button = element('button', 'cw-preset');
      button.type = 'button';
      button.classList.toggle('active', sameTheme(colors, this.theme));
      const swatch = element('span', 'cw-swatch');
      swatch.style.background = `linear-gradient(135deg, ${colors.bg} 0 33%, ${colors.panel} 33% 66%, ${colors.accent} 66%)`;
      button.append(swatch, element('span', '', name));
      button.addEventListener('click', () => this.setTheme({ ...colors }));
      wrap.appendChild(button);
      if (removable) {
        const remove = element('button', 'cw-preset-remove', '×');
        remove.type = 'button';
        remove.title = `Delete "${name}"`;
        remove.addEventListener('click', () => {
          deleteCustomTheme(name);
          this.renderPresets();
        });
        wrap.appendChild(remove);
      }
      return wrap;
    };
    for (const [name, colors] of Object.entries(THEME_PRESETS)) chips.push(chip(name, colors, false));
    for (const [name, colors] of Object.entries(customThemes())) chips.push(chip(name, colors, true));
    this.presetsBox.replaceChildren(...chips);
  }

  private setTheme(theme: ThemeColors, from?: keyof ThemeColors): void {
    this.theme = theme;
    applyTheme(theme);
    saveTheme(theme);
    this.syncInputs(from);
    this.renderPresets();
  }

  private syncInputs(skip?: keyof ThemeColors): void {
    for (const [key, input] of this.colorInputs) if (key !== skip) input.value = this.theme[key];
  }

  // ---- server ----

  private buildProject(): HTMLElement {
    const section = element('section', 'cw-settings-section');
    section.append(element('h2', '', 'Projects'));
    section.append(element('p', 'cw-settings-hint', 'Frame rate projects run at. Scratch uses 30; Codewarp defaults to 60.'));
    const row = element('div', 'cw-settings-buttons');
    const input = element('input');
    input.type = 'number';
    input.min = '10';
    input.max = '250';
    input.value = String(getFramerate());
    const apply = (fps: number): void => {
      if (!Number.isFinite(fps)) return;
      saveFramerate(fps);
      input.value = String(getFramerate());
      this.onFramerate(getFramerate());
    };
    input.addEventListener('change', () => apply(Number(input.value)));
    row.append(input, element('span', '', 'fps'));
    for (const preset of [30, 60, 120]) {
      const button = element('button', '', String(preset));
      button.type = 'button';
      button.addEventListener('click', () => apply(preset));
      row.appendChild(button);
    }
    section.appendChild(row);

    const label = element('label', 'cw-check-row');
    const check = element('input');
    check.type = 'checkbox';
    check.checked = getScratchSprites();
    check.addEventListener('change', () => saveScratchSprites(check.checked));
    label.append(check, element('span', '', 'Scratch-style sprite area (blue panel, big sprite tiles)'));
    section.appendChild(label);
    return section;
  }

  private buildDiagnostics(diag: { text(): string; clear(): void }): HTMLElement {
    const section = element('section', 'cw-settings-section');
    section.append(element('h2', '', 'Diagnostics'));
    section.append(element('p', 'cw-settings-hint', 'Errors and sync problems are recorded here. If something breaks, copy this and send it to me.'));
    const box = element('textarea', 'cw-diag');
    box.readOnly = true;
    box.rows = 8;
    const refresh = (): void => {
      box.value = diag.text() || '(nothing recorded)';
    };
    const buttons = element('div', 'cw-settings-buttons');
    const reload = element('button', '', 'Refresh');
    const copy = element('button', '', 'Copy');
    const clear = element('button', '', 'Clear');
    for (const b of [reload, copy, clear]) b.type = 'button';
    reload.addEventListener('click', refresh);
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(diag.text()));
    clear.addEventListener('click', () => {
      diag.clear();
      refresh();
    });
    buttons.append(reload, copy, clear);
    refresh();
    section.append(box, buttons);
    return section;
  }

  private buildServer(): HTMLElement {
    const section = element('section', 'cw-settings-section');
    section.append(element('h2', '', 'Collaboration server'));
    section.append(
      element(
        'p',
        'cw-settings-hint',
        'Real-time collaboration connects to this server. The default is the project server. Changing it applies the next time you join a room.',
      ),
    );

    const input = element('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = collabServerUrl();
    input.placeholder = DEFAULT_SERVER_URL;

    const message = element('p', 'cw-settings-message');
    const say = (text: string, bad = false) => {
      message.textContent = text;
      message.classList.toggle('cw-bad', bad);
    };

    const save = element('button', 'active', 'Save');
    save.type = 'button';
    save.addEventListener('click', () => {
      const value = input.value.trim();
      if (value && !isValidServerUrl(value)) {
        say('The address must start with ws:// or wss://', true);
        return;
      }
      saveServerUrl(value);
      input.value = collabServerUrl();
      say(input.value === DEFAULT_SERVER_URL ? 'Using the default server.' : 'Saved. It is used the next time you join a room.');
    });

    const test = element('button', '', 'Test connection');
    test.type = 'button';
    test.addEventListener('click', async () => {
      const value = input.value.trim() || DEFAULT_SERVER_URL;
      if (!isValidServerUrl(value)) {
        say('The address must start with ws:// or wss://', true);
        return;
      }
      test.disabled = true;
      say('Connecting…');
      const problem = await testServer(value);
      test.disabled = false;
      say(problem ? `${problem}.` : 'Connected: the server answered.', Boolean(problem));
    });

    const useDefault = element('button', '', 'Use default server');
    useDefault.type = 'button';
    useDefault.addEventListener('click', () => {
      saveServerUrl('');
      input.value = DEFAULT_SERVER_URL;
      say('Using the default server.');
    });

    const useLocal = element('button', '', 'Use this computer');
    useLocal.type = 'button';
    useLocal.title = `For testing: a server started with "npm run server" (${LOCAL_SERVER_URL})`;
    useLocal.addEventListener('click', () => {
      input.value = LOCAL_SERVER_URL;
      save.click();
    });

    const buttons = element('div', 'cw-settings-buttons');
    buttons.append(save, test, useDefault, useLocal);
    section.append(input, buttons, message, element('p', 'cw-settings-hint', `Default: ${DEFAULT_SERVER_URL}`));
    return section;
  }
}
