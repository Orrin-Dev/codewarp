/**
 * Pure pixel helpers for the costume editor (no DOM, so they can be tested on their own).
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** '#rrggbb' (or '#rgb') to an RGBA color. */
export function hexToRgba(hex: string, alpha = 255): Rgba {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0, a: alpha };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: alpha };
}

export function rgbaToHex(r: number, g: number, b: number): string {
  const part = (v: number) => v.toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * Flood fill (scanline). Fills the region around (x, y) whose pixels are within `tolerance`
 * (per channel) of the pixel at (x, y), and writes `fill` into `data` in place.
 * Returns how many pixels were changed.
 */
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  fill: Rgba,
  tolerance = 32,
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;

  const start = (y * width + x) * 4;
  const tr = data[start];
  const tg = data[start + 1];
  const tb = data[start + 2];
  const ta = data[start + 3];

  const matches = (px: number, py: number): boolean => {
    const i = (py * width + px) * 4;
    return (
      Math.abs(data[i] - tr) <= tolerance &&
      Math.abs(data[i + 1] - tg) <= tolerance &&
      Math.abs(data[i + 2] - tb) <= tolerance &&
      Math.abs(data[i + 3] - ta) <= tolerance
    );
  };

  // `visited` also stops the fill from looping when the fill color is within tolerance of the target.
  const visited = new Uint8Array(width * height);
  const stack: number[] = [x, y];
  let changed = 0;

  while (stack.length > 0) {
    const sy = stack.pop() as number;
    const sx = stack.pop() as number;
    if (visited[sy * width + sx]) continue;

    let left = sx;
    while (left > 0 && !visited[sy * width + left - 1] && matches(left - 1, sy)) left--;
    let right = sx;
    while (right < width - 1 && !visited[sy * width + right + 1] && matches(right + 1, sy)) right++;

    for (let px = left; px <= right; px++) {
      visited[sy * width + px] = 1;
      const i = (sy * width + px) * 4;
      data[i] = fill.r;
      data[i + 1] = fill.g;
      data[i + 2] = fill.b;
      data[i + 3] = fill.a;
      changed++;
    }

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let inRun = false;
      for (let px = left; px <= right; px++) {
        const ok = !visited[ny * width + px] && matches(px, ny);
        if (ok && !inRun) {
          stack.push(px, ny);
          inRun = true;
        } else if (!ok) {
          inRun = false;
        }
      }
    }
  }
  return changed;
}
