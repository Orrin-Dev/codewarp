/**
 * Pure audio helpers for the sound editor (no DOM / Web Audio, so they can be tested on their own).
 * A sound is plain PCM: one Float32Array per channel, samples in -1..1.
 * Every operation returns a new Pcm and never changes its input, which makes undo trivial.
 */

export interface Pcm {
  channels: Float32Array[];
  sampleRate: number;
}

export interface Range {
  /** First sample (inclusive). */
  start: number;
  /** End sample (exclusive). */
  end: number;
}

export const lengthOf = (pcm: Pcm): number => pcm.channels[0]?.length ?? 0;

export const durationOf = (pcm: Pcm): number => lengthOf(pcm) / pcm.sampleRate;

/** Clamp a range into the sound. No selection (null) or an empty one means "the whole sound". */
export function normalizeRange(pcm: Pcm, range: Range | null): Range {
  const len = lengthOf(pcm);
  if (!range) return { start: 0, end: len };
  const start = Math.max(0, Math.min(len, Math.floor(Math.min(range.start, range.end))));
  const end = Math.max(0, Math.min(len, Math.ceil(Math.max(range.start, range.end))));
  return end > start ? { start, end } : { start: 0, end: len };
}

const clampSample = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Copy of the sound with `fn` applied to every sample inside the range. */
function mapRange(
  pcm: Pcm,
  range: Range,
  fn: (sample: number, indexInRange: number, rangeLength: number) => number,
): Pcm {
  const n = range.end - range.start;
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch);
      for (let i = 0; i < n; i++) out[range.start + i] = clampSample(fn(ch[range.start + i], i, n));
      return out;
    }),
  };
}

/** Keep only the range (trim to selection). */
export function keepRange(pcm: Pcm, range: Range): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => ch.slice(range.start, range.end)),
  };
}

/** Remove the range and join what is left. */
export function deleteRange(pcm: Pcm, range: Range): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch.length - (range.end - range.start));
      out.set(ch.subarray(0, range.start), 0);
      out.set(ch.subarray(range.end), range.start);
      return out;
    }),
  };
}

export const fadeIn = (pcm: Pcm, range: Range): Pcm =>
  mapRange(pcm, range, (s, i, n) => s * (n <= 1 ? 1 : i / (n - 1)));

export const fadeOut = (pcm: Pcm, range: Range): Pcm =>
  mapRange(pcm, range, (s, i, n) => s * (n <= 1 ? 1 : 1 - i / (n - 1)));

export const gain = (pcm: Pcm, range: Range, factor: number): Pcm => mapRange(pcm, range, (s) => s * factor);

export const mute = (pcm: Pcm, range: Range): Pcm => mapRange(pcm, range, () => 0);

export function reverse(pcm: Pcm, range: Range): Pcm {
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(ch);
      for (let i = range.start; i < range.end; i++) out[i] = ch[range.end - 1 - (i - range.start)];
      return out;
    }),
  };
}

/**
 * Play the whole sound `factor` times faster (>1) or slower (<1). Pitch changes with speed,
 * like speeding up a tape. Linear interpolation; at least one sample is kept.
 */
export function changeSpeed(pcm: Pcm, factor: number): Pcm {
  const len = lengthOf(pcm);
  const newLen = Math.max(1, Math.round(len / factor));
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((ch) => {
      const out = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        const pos = (i * (len - 1)) / Math.max(1, newLen - 1);
        const i0 = Math.floor(pos);
        const i1 = Math.min(len - 1, i0 + 1);
        const t = pos - i0;
        out[i] = ch[i0] * (1 - t) + ch[i1] * t;
      }
      return out;
    }),
  };
}

/** Peak (min, max) per column, for drawing a waveform `columns` pixels wide. */
export function waveformPeaks(pcm: Pcm, columns: number): { min: Float32Array; max: Float32Array } {
  const len = lengthOf(pcm);
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  if (len === 0) return { min, max };
  for (let x = 0; x < columns; x++) {
    const from = Math.floor((x * len) / columns);
    const to = Math.max(from + 1, Math.floor(((x + 1) * len) / columns));
    let lo = 1;
    let hi = -1;
    for (const ch of pcm.channels) {
      for (let i = from; i < to && i < len; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[x] = lo > hi ? 0 : lo;
    max[x] = hi < lo ? 0 : hi;
  }
  return { min, max };
}

/** 16-bit PCM WAV file bytes. */
export function encodeWav(pcm: Pcm): Uint8Array {
  const channelCount = pcm.channels.length;
  const frames = lengthOf(pcm);
  const bytesPerSample = 2;
  const dataSize = frames * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channelCount * bytesPerSample, true); // byte rate
  view.setUint16(32, channelCount * bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const s = clampSample(pcm.channels[c][i]);
      view.setInt16(offset, Math.round(s < 0 ? s * 32768 : s * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}
