import {
  DEFAULT_SERVER_URL,
  LOCAL_SERVER_URL,
  THEME_PRESETS,
  applyTheme,
  collabServerUrl,
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

  constructor(private readonly root: HTMLElement) {
    root.classList.add('cw-settings');
    const page = element('div', 'cw-settings-page');
    page.append(this.buildAppearance(), this.buildServer());
    root.replaceChildren(page);
  }

  // ---- appearance ----

  private buildAppearance(): HTMLElement {
    const section = element('section', 'cw-settings-section');
    section.append(element('h2', '', 'Appearance'));

    const presets = element('div', 'cw-presets');
    for (const [name, colors] of Object.entries(THEME_PRESETS)) {
      const chip = element('button', 'cw-preset');
      chip.type = 'button';
      const swatch = element('span', 'cw-swatch');
      swatch.style.background = `linear-gradient(135deg, ${colors.panel} 50%, ${colors.accent} 50%)`;
      chip.append(swatch, element('span', '', name));
      chip.addEventListener('click', () => this.setTheme({ ...colors }));
      presets.appendChild(chip);
    }
    section.appendChild(presets);

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

    const reset = element('button', '', 'Reset colours');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      resetTheme();
      this.theme = currentTheme();
      this.syncInputs();
    });
    section.append(reset);
    return section;
  }

  private setTheme(theme: ThemeColors, from?: keyof ThemeColors): void {
    this.theme = theme;
    applyTheme(theme);
    saveTheme(theme);
    this.syncInputs(from);
  }

  private syncInputs(skip?: keyof ThemeColors): void {
    for (const [key, input] of this.colorInputs) if (key !== skip) input.value = this.theme[key];
  }

  // ---- server ----

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
