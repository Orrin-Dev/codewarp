/** Pick a file with the browser's own dialog (works in Electron too). Resolves null if cancelled. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** File name without its extension. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
}
