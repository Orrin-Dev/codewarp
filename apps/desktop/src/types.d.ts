// The Scratch packages ship no TypeScript types, so they are untyped (any) for now.
declare module 'scratch-vm';
declare module 'scratch-render';
declare module 'scratch-storage';
declare module 'scratch-audio';
declare module 'scratch-svg-renderer';
declare module 'scratch-blocks';

// Exposed by electron/preload.cjs. Undefined when running in a plain browser.
interface CodewarpBridge {
  openProject(): Promise<{ name: string; data: Uint8Array } | null>;
  saveProject(suggestedName: string, data: Uint8Array): Promise<string | null>;
}

interface Window {
  codewarp?: CodewarpBridge;
}
