/*
 * A small in-memory log of errors and notable events (sync repairs, reconnects, ...). It is shown
 * in Settings > Diagnostics so a bug report can include what actually went wrong.
 */

const MAX_LINES = 300;
const lines: string[] = [];

const stamp = (): string => new Date().toTimeString().slice(0, 8);

function text(value: unknown): string {
  if (value instanceof Error) return value.stack?.split('\n').slice(0, 4).join(' | ') ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Record one line. */
export function logDiag(kind: string, ...parts: unknown[]): void {
  lines.push(`${stamp()} [${kind}] ${parts.map(text).join(' ')}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

export const diagnostics = {
  text: (): string => lines.join('\n'),
  clear: (): void => {
    lines.length = 0;
  },
};

/** Capture uncaught errors, rejected promises and console.error. Call once at start. */
export function installDiagnostics(): void {
  window.addEventListener('error', (e) => logDiag('error', e.message, `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => logDiag('rejection', e.reason));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logDiag('console.error', ...args);
    original(...args);
  };
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    logDiag('console.warn', ...args);
    warn(...args);
  };
}
