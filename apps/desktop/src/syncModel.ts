import type { CostumeMeta, SoundMeta, SpriteProps, SpriteState } from '@codewarp/core';

/*
 * Pure logic for keeping project state in step between people. No VM or DOM in here, so it is
 * easy to test. stateSync.ts connects it to the real VM.
 */

// ---- hashing ----------------------------------------------------------------

/** JSON with object keys sorted, so equal data always gives equal text. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

/** Small fast non-cryptographic hash (FNV-1a), as 8 hex digits. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const hashValue = (value: unknown): string => hashText(stableStringify(value));

// ---- numbers ----------------------------------------------------------------

/** Round to 2 decimals so tiny float differences never look like a change. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---- keys and comparison ----------------------------------------------------

/** What makes two costumes "the same picture". The name is not part of it, so renaming is not a replacement. */
export const costumeKey = (c: CostumeMeta): string =>
  `${c.assetId}|${c.dataFormat}|${round2(c.rotationCenterX)}|${round2(c.rotationCenterY)}|${c.bitmapResolution}`;

export const soundKey = (s: SoundMeta): string => `${s.assetId}|${s.dataFormat}|${s.rate}|${s.sampleCount}`;

export function sameProps(a: SpriteProps, b: SpriteProps): boolean {
  return stableStringify(a) === stableStringify(b);
}

const sameList = <T>(a: T[], b: T[], key: (item: T) => string): boolean =>
  a.length === b.length && a.every((item, i) => key(item) === key(b[i]) && (item as { name: string }).name === (b[i] as { name: string }).name);

/** Everything needed to describe one sprite's synced state. */
export interface FullSpriteState {
  name: string;
  props: SpriteProps;
  costumes: CostumeMeta[];
  sounds: SoundMeta[];
}

/**
 * What changed between two states of the same sprite, or null if nothing did.
 * With `ignoreProps` the position, rotation and so on are left out (used while a test is running,
 * when scripts move sprites constantly).
 */
export function diffSprite(prev: FullSpriteState | undefined, next: FullSpriteState, ignoreProps = false): SpriteState | null {
  const change: SpriteState = { name: next.name };
  let changed = false;
  if (!ignoreProps && (!prev || !sameProps(prev.props, next.props))) {
    change.props = next.props;
    changed = true;
  }
  if (!prev || !sameList(prev.costumes, next.costumes, costumeKey)) {
    change.costumes = next.costumes;
    changed = true;
  }
  if (!prev || !sameList(prev.sounds, next.sounds, soundKey)) {
    change.sounds = next.sounds;
    changed = true;
  }
  return changed ? change : null;
}

// ---- turning one list into another ------------------------------------------

export type ListStep =
  /** Add the item that should end up at `desiredIndex` (it goes on the end for now). */
  | { type: 'add'; desiredIndex: number }
  /** Remove the item at `index` (indexes refer to the list as it is when this step runs). */
  | { type: 'delete'; index: number }
  /** Move the item at `from` so it sits at `to`. */
  | { type: 'move'; from: number; to: number };

/**
 * Plan how to turn a list of items (identified by key) into the desired one using only add, delete and
 * move, in an order that works with the VM: add first (a sprite can never be left with zero costumes),
 * then delete, then reorder. Items with the same key (duplicated costumes) are matched one to one.
 */
export function planList(current: string[], desired: string[]): ListStep[] {
  const steps: ListStep[] = [];
  const list = [...current];

  // 1. Add whatever is missing.
  const available = new Map<string, number>();
  for (const key of list) available.set(key, (available.get(key) ?? 0) + 1);
  desired.forEach((key, desiredIndex) => {
    const have = available.get(key) ?? 0;
    if (have > 0) {
      available.set(key, have - 1);
    } else {
      steps.push({ type: 'add', desiredIndex });
      list.push(key);
    }
  });

  // 2. Delete what is no longer wanted (the last copies first, so earlier ones keep their place).
  const wanted = new Map<string, number>();
  for (const key of desired) wanted.set(key, (wanted.get(key) ?? 0) + 1);
  const seen = new Map<string, number>();
  const keep = list.map((key) => {
    const used = (seen.get(key) ?? 0) + 1;
    seen.set(key, used);
    return used <= (wanted.get(key) ?? 0);
  });
  for (let i = list.length - 1; i >= 0; i--) {
    if (!keep[i]) {
      steps.push({ type: 'delete', index: i });
      list.splice(i, 1);
    }
  }

  // 3. Put what is left in order.
  for (let i = 0; i < desired.length; i++) {
    if (list[i] === desired[i]) continue;
    let from = -1;
    for (let j = i + 1; j < list.length; j++) {
      if (list[j] === desired[i]) {
        from = j;
        break;
      }
    }
    if (from < 0) throw new Error('planList: lists do not contain the same items');
    steps.push({ type: 'move', from, to: i });
    const [item] = list.splice(from, 1);
    list.splice(i, 0, item);
  }
  return steps;
}

/** Run a plan on a plain array (used by the tests to prove a plan is right). */
export function applyPlan(current: string[], desired: string[], steps: ListStep[]): string[] {
  const list = [...current];
  for (const step of steps) {
    if (step.type === 'add') list.push(desired[step.desiredIndex]);
    else if (step.type === 'delete') list.splice(step.index, 1);
    else list.splice(step.to, 0, ...list.splice(step.from, 1));
  }
  return list;
}

// ---- comparing digests ------------------------------------------------------

export interface DigestComparison {
  /** Sprites on one side only, so the lists of sprites differ. */
  structureDiffers: boolean;
  /** Sprites present on both sides with different contents. */
  differing: string[];
}

export function compareDigests(mine: Record<string, string>, theirs: Record<string, string>): DigestComparison {
  const myNames = Object.keys(mine).sort();
  const theirNames = Object.keys(theirs).sort();
  const structureDiffers = myNames.length !== theirNames.length || myNames.some((name, i) => name !== theirNames[i]);
  const differing = myNames.filter((name) => name in theirs && mine[name] !== theirs[name]);
  return { structureDiffers, differing };
}
