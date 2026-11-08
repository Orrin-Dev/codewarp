/**
 * The Scratch packages are old CommonJS/UMD bundles. Depending on how Vite
 * pre-bundles them, `import X from 'pkg'` can yield the module itself, or a
 * wrapper object such as `{ default: X }`. This unwraps down to the real export.
 */
export function interop<T = any>(mod: any, name?: string): T {
  let m = mod;
  while (m && typeof m === 'object' && 'default' in m && m.default) {
    m = m.default;
  }
  if (name && typeof m !== 'function') {
    // Not a class/function: look for it as a named property before giving up.
    for (const candidate of [m, mod, mod?.default]) {
      if (candidate && typeof candidate[name] === 'function') return candidate[name] as T;
    }
    const keys = Object.keys(mod ?? {}).join(', ');
    throw new Error(
      `${name}: no constructor found (module keys: [${keys}], default is ${typeof mod?.default})`,
    );
  }
  return m as T;
}
