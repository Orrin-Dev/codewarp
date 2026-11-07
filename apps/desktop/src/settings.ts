import { COLLAB_DEV_SERVER_URL, COLLAB_SERVER_URL } from '@codewarp/core';

/*
 * App settings, kept in localStorage: the colours and which collaboration server to use.
 * Only what the user changed is stored, so a default that changes in a new release still reaches
 * everyone who never touched it.
 */

export interface ThemeColors {
  bg: string;
  panel: string;
  text: string;
  accent: string;
}

export const DEFAULT_THEME: ThemeColors = { bg: '#14161c', panel: '#1c1f27', text: '#e6e8ee', accent: '#6d7cff' };

export const THEME_PRESETS: Record<string, ThemeColors> = {
  Default: DEFAULT_THEME,
  Midnight: { bg: '#0b0d12', panel: '#12151c', text: '#dfe3ee', accent: '#58a6ff' },
  Forest: { bg: '#101613', panel: '#17201b', text: '#e3ece6', accent: '#3fb27f' },
  Rose: { bg: '#181318', panel: '#211a21', text: '#f0e6ee', accent: '#e0609a' },
  Light: { bg: '#eef0f5', panel: '#ffffff', text: '#1f2430', accent: '#5865f2' },
};

/** The server every copy of Codewarp uses until the user picks another one. */
export const DEFAULT_SERVER_URL = COLLAB_SERVER_URL;
/** A server running on this computer (`npm run server`), handy for testing. */
export const LOCAL_SERVER_URL = COLLAB_DEV_SERVER_URL;

interface Stored {
  theme?: ThemeColors;
  serverUrl?: string;
}

const KEY = 'codewarp.settings';

function read(): Stored {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(stored: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    /* storage unavailable: the setting just lasts until the app closes */
  }
}

// ---- colours ----------------------------------------------------------------

const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function parseHex(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

/** Blend `from` towards `to` by `amount` (0 to 1). */
function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
}

const luminance = (hex: string): number => {
  const [r, g, b] = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/** All the CSS variables for a set of four colours. The in-between shades are worked out from them. */
export function themeVariables(theme: ThemeColors): Record<string, string> {
  const light = luminance(theme.panel) > 0.5;
  const toward = light ? '#000000' : '#ffffff';
  return {
    '--bg': theme.bg,
    '--panel': theme.panel,
    '--panel-2': mix(theme.panel, toward, light ? 0.05 : 0.06),
    '--border': mix(theme.panel, toward, light ? 0.16 : 0.14),
    '--text': theme.text,
    '--muted': mix(theme.text, theme.panel, 0.42),
    '--accent': theme.accent,
  };
}

export function currentTheme(): ThemeColors {
  const saved = read().theme;
  if (saved && [saved.bg, saved.panel, saved.text, saved.accent].every(isHex)) return saved;
  return DEFAULT_THEME;
}

export function applyTheme(theme: ThemeColors): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);
  root.dataset.theme = luminance(theme.panel) > 0.5 ? 'light' : 'dark';
}

export function saveTheme(theme: ThemeColors): void {
  const stored = read();
  stored.theme = theme;
  write(stored);
  applyTheme(theme);
}

export function resetTheme(): void {
  const stored = read();
  delete stored.theme;
  write(stored);
  applyTheme(DEFAULT_THEME);
}

/** Call once when the app starts. */
export function applySavedTheme(): void {
  applyTheme(currentTheme());
}

// ---- collaboration server ---------------------------------------------------

/** True for ws:// or wss:// addresses. */
export function isValidServerUrl(url: string): boolean {
  return /^wss?:\/\/[^\s/]+(\/\S*)?$/i.test(url);
}

export function collabServerUrl(): string {
  const saved = read().serverUrl;
  return saved && isValidServerUrl(saved) ? saved : DEFAULT_SERVER_URL;
}

/** Use `url`, or the default server when it is empty or the same as the default. */
export function saveServerUrl(url: string): void {
  const stored = read();
  const clean = url.trim();
  if (!clean || clean === DEFAULT_SERVER_URL) delete stored.serverUrl;
  else stored.serverUrl = clean;
  write(stored);
}

/** Try to open a connection to the server. Resolves with an error message, or null when it answered. */
export function testServer(url: string, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve('That is not a valid address');
      return;
    }
    const finish = (result: string | null) => {
      window.clearTimeout(timer);
      socket.onopen = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = window.setTimeout(() => finish('No answer (timed out)'), timeoutMs);
    socket.onopen = () => finish(null);
    socket.onerror = () => finish('Could not connect');
    socket.onclose = () => finish('Could not connect');
  });
}
