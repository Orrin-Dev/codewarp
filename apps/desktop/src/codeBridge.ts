import {
  type ParseResult,
  type Proc,
  type Skin,
  type VarDecl,
  type VmBlock,
  type XmlContext,
  printItems,
  printScript,
  readItems,
  readProcs,
  scriptToXml,
} from '@codewarp/core';

/*
 * Connects the text engine (packages/core/src/code) to the project: reads the sprite being edited as text,
 * and puts parsed text back into the blocks workspace as ordinary block edits (so undo, the VM and real-time
 * collaboration all see them like any other edit).
 */

export interface Snapshot {
  text: string;
  /** The text of each script as of this snapshot. Only scripts that were in the text can be removed by editing it. */
  base: string[];
  /** Ids of scripts shown as "kept:" comments. */
  keptIds: string[];
}

const blocksOf = (vm: any): Record<string, VmBlock> => vm.editingTarget?.blocks?._blocks ?? {};

export function readDecls(vm: any): VarDecl[] {
  const target = vm.editingTarget;
  if (!target) return [];
  const stage = vm.runtime.getTargetForStage?.();
  const decls: VarDecl[] = [];
  const add = (variables: Record<string, any> | undefined, local: boolean): void => {
    for (const v of Object.values<any>(variables ?? {})) {
      if (v.type === 'broadcast_msg') continue;
      decls.push({ name: String(v.name), type: v.type === 'list' ? 'list' : 'var', local, cloud: Boolean(v.isCloud) });
    }
  };
  if (stage && stage !== target) add(stage.variables, false);
  add(target.variables, !target.isStage);
  return decls;
}

export function externalProcs(vm: any): Proc[] {
  return readProcs(blocksOf(vm)).map((p) => ({ proccode: p.proccode, argNames: p.argNames, warp: p.warp }));
}

/** The text for the sprite being edited. */
export function generate(vm: any, skin: Skin): Snapshot {
  const items = readItems(blocksOf(vm));
  const text = printItems(items, readDecls(vm), skin);
  const base: string[] = [];
  const keptIds: string[] = [];
  for (const item of items) {
    if ('script' in item) base.push(printScript(item.script, skin));
    else keptIds.push(item.kept.id);
  }
  return { text, base, keptIds };
}

const hashText = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export interface ApplyStats {
  added: number;
  removed: number;
  snapshot: Snapshot;
}

/**
 * Make the workspace match parsed text. Scripts whose text did not change are left completely alone (same
 * blocks, same place, nothing sent to collaborators); changed ones are replaced where they were.
 */
export function applyParsed(
  vm: any,
  workspace: any,
  Blockly: any,
  result: ParseResult,
  skin: Skin,
  previous: Snapshot,
): ApplyStats {
  const target = vm.editingTarget;
  const blocks = blocksOf(vm);
  const old = readItems(blocks);

  const oldScripts = old.flatMap((item) => ('script' in item ? [{ id: item.script.id!, x: item.script.x, y: item.script.y, text: printScript(item.script, skin) }] : []));
  const oldKept = old.flatMap((item) => ('kept' in item ? [item.kept] : []));
  const newTexts = result.scripts.map((s) => printScript(s, skin));

  // Which old scripts does the new text still have?
  const unusedByText = new Map<string, number[]>();
  oldScripts.forEach((s, i) => unusedByText.set(s.text, [...(unusedByText.get(s.text) ?? []), i]));
  const addIndexes: number[] = [];
  newTexts.forEach((text, i) => {
    const list = unusedByText.get(text);
    if (list && list.length > 0) list.shift();
    else addIndexes.push(i);
  });
  const baseCount = new Map<string, number>();
  for (const t of previous.base) baseCount.set(t, (baseCount.get(t) ?? 0) + 1);
  const removeScripts = oldScripts
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => (unusedByText.get(s.text) ?? []).includes(i))
    .filter(({ s }) => {
      // Only scripts that were in the text can be removed by editing it. Others arrived from a collaborator meanwhile.
      const left = baseCount.get(s.text) ?? 0;
      if (left <= 0) return false;
      baseCount.set(s.text, left - 1);
      return true;
    })
    .map(({ s }) => s);
  const removeKept = oldKept.filter((k) => previous.keptIds.includes(k.id) && !result.kept.has(k.id));

  const procIds = new Map(readProcs(blocks).map((p) => [p.proccode, p.argIds] as const));
  const ctx: XmlContext = {
    varId: (name, kind) => {
      const type = kind === 'list' ? 'list' : kind === 'broadcast' ? 'broadcast_msg' : '';
      const found = workspace.getVariable(name, type);
      return (found ?? workspace.createVariable(name, type)).getId();
    },
    procArgIds: (proccode, count) => {
      const existing = procIds.get(proccode);
      if (existing && existing.length === count) return existing;
      const seed = hashText(proccode);
      return Array.from({ length: count }, (_, i) => `arg${seed}_${i}`);
    },
  };

  const changed = addIndexes.length > 0 || removeScripts.length > 0 || removeKept.length > 0;
  Blockly.Events.setGroup(true);
  try {
    // Variables and lists named at the top of the text.
    for (const decl of result.decls) {
      const type = decl.type === 'list' ? 'list' : '';
      if (!workspace.getVariable(decl.name, type)) workspace.createVariable(decl.name, type, null, decl.local && !target.isStage, decl.cloud);
    }

    const spots: { x: number; y: number }[] = [];
    for (const s of [...removeScripts, ...removeKept]) {
      spots.push({ x: s.x, y: s.y });
      workspace.getBlockById(('id' in s ? s.id : '') as string)?.dispose(false);
    }

    let bottom = 0;
    let left = Infinity;
    for (const top of workspace.getTopBlocks(false)) {
      const at = top.getRelativeToSurfaceXY();
      left = Math.min(left, at.x);
      bottom = Math.max(bottom, at.y + (top.getHeightWidth?.().height ?? 100));
    }
    let nextY = bottom + 40;
    const nextX = Number.isFinite(left) ? left : 40;
    if (!Number.isFinite(left)) nextY = 40;

    const xml: string[] = [];
    addIndexes.forEach((index, k) => {
      const script = result.scripts[index];
      let spot = spots[k];
      if (!spot) {
        spot = { x: nextX, y: nextY };
        nextY += 160;
      }
      xml.push(scriptToXml(script, ctx, spot.x, spot.y));
    });
    if (xml.length > 0) Blockly.Xml.domToWorkspace(Blockly.Xml.textToDom(`<xml>${xml.join('')}</xml>`), workspace);
  } finally {
    Blockly.Events.setGroup(false);
  }

  void changed;
  return {
    added: addIndexes.length,
    removed: removeScripts.length + removeKept.length,
    snapshot: { text: '', base: newTexts, keptIds: oldKept.filter((k) => result.kept.has(k.id)).map((k) => k.id) },
  };
}
