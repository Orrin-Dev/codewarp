/*
 * Dropdown menus whose choices depend on the project: costumes, backdrops, sounds and sprites.
 * scratch-blocks only ships placeholder lists, and the Scratch editor replaces them like this.
 * The option functions run each time a dropdown opens, so they always see the current project.
 */

type Option = [string, string];

export function installProjectMenus(Blockly: any, vm: any): void {
  const msg = (key: string, fallback: string): string => Blockly.Msg?.[key] ?? fallback;

  const costumes = (): Option[] => {
    const list: Option[] = (vm.editingTarget?.getCostumes?.() ?? []).map((c: { name: string }) => [c.name, c.name]);
    return list.length ? list : [['', '']];
  };
  const backdrops = (): Option[] => {
    const stage = vm.runtime?.getTargetForStage?.();
    const list: Option[] = (stage?.getCostumes?.() ?? []).map((c: { name: string }) => [c.name, c.name]);
    return list.length ? list : [['', '']];
  };
  const sounds = (): Option[] => {
    const list: Option[] = (vm.editingTarget?.getSounds?.() ?? []).map((s: { name: string }) => [s.name, s.name]);
    return list.length ? list : [['', '']];
  };
  /** Every other sprite in the project (not the stage, not the one being edited). */
  const sprites = (): Option[] => {
    const list: Option[] = [];
    for (const target of vm.runtime?.targets ?? []) {
      if (!target.isOriginal || target.isStage || target === vm.editingTarget) continue;
      list.push([target.sprite.name, target.sprite.name]);
    }
    return list;
  };

  /**
   * A dropdown must never have zero options: Blockly throws while laying out the flyout, and every
   * block after it piles up at the top of the palette. (The stage with no sprites hits this.)
   */
  const safeOptions = (start: Option[], options: () => Option[]): Option[] => {
    try {
      const list = start.concat(options());
      return list.length ? list : [['', '']];
    } catch (error) {
      console.error('Dropdown options failed', error);
      return start.length ? start : [['', '']];
    }
  };

  const define = (type: string, field: string, options: () => Option[], colours: any, start: Option[] = []): void => {
    const definition = Blockly.Blocks[type];
    if (!definition) return;
    definition.init = function () {
      this.jsonInit({
        message0: '%1',
        args0: [{ type: 'field_dropdown', name: field, options: () => safeOptions(start, options) }],
        inputsInline: true,
        output: 'String',
        colour: colours.secondary,
        colourSecondary: colours.secondary,
        colourTertiary: colours.tertiary,
        outputShape: Blockly.OUTPUT_SHAPE_ROUND,
      });
    };
  };

  const c = Blockly.Colours ?? {};
  define('looks_costume', 'COSTUME', costumes, c.looks);
  define('looks_backdrops', 'BACKDROP', backdrops, c.looks);
  define('sound_sounds_menu', 'SOUND_MENU', sounds, c.sounds);
  define('motion_goto_menu', 'TO', sprites, c.motion, [
    [msg('MOTION_GOTO_RANDOM', 'random position'), '_random_'],
    [msg('MOTION_GOTO_POINTER', 'mouse-pointer'), '_mouse_'],
  ]);
  define('motion_glideto_menu', 'TO', sprites, c.motion, [
    [msg('MOTION_GLIDETO_RANDOM', 'random position'), '_random_'],
    [msg('MOTION_GLIDETO_POINTER', 'mouse-pointer'), '_mouse_'],
  ]);
  define('motion_pointtowards_menu', 'TOWARDS', sprites, c.motion, [
    [msg('MOTION_POINTTOWARDS_POINTER', 'mouse-pointer'), '_mouse_'],
  ]);
  define('sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU', sprites, c.sensing, [
    [msg('SENSING_TOUCHINGOBJECT_POINTER', 'mouse-pointer'), '_mouse_'],
    [msg('SENSING_TOUCHINGOBJECT_EDGE', 'edge'), '_edge_'],
  ]);
  define('sensing_distancetomenu', 'DISTANCETOMENU', sprites, c.sensing, [
    [msg('SENSING_DISTANCETO_POINTER', 'mouse-pointer'), '_mouse_'],
  ]);
  define('sensing_of_object_menu', 'OBJECT', sprites, c.sensing, [
    [msg('SENSING_OF_STAGE', 'Stage'), '_stage_'],
  ]);
  // The stage cannot clone itself, so "myself" is only offered to sprites.
  define(
    'control_create_clone_of_menu',
    'CLONE_OPTION',
    () => [
      ...(vm.editingTarget?.isStage ? [] : ([[msg('CONTROL_CREATECLONEOF_MYSELF', 'myself'), '_myself_']] as Option[])),
      ...sprites(),
    ],
    c.control,
  );
}
