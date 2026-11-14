/*
 * Every block the text syntaxes know, in one table. A line is:
 *   kind | opcode | name | arguments...
 * kinds: S statement, R reporter, B boolean, H hat, C C-shaped block, P cap (a statement that ends a script).
 * arguments: NAME:type where type is
 *   n[/shadow]   number input             s   text input             c   colour input
 *   b            boolean input            menu/shadow/FIELD   dropdown input
 *   field        dropdown on the block    var / list   a variable / list name   bfield   broadcast name on a block
 *   bcast        broadcast input          stack   blocks inside a C-shaped block
 * A leading "@" on the first argument means it is written before the dot: items.add(x).
 */
export type ArgKind = 'n' | 's' | 'c' | 'b' | 'menu' | 'field' | 'var' | 'list' | 'bfield' | 'bcast' | 'stack';

export interface ArgSpec {
  name: string;
  kind: ArgKind;
  /** Shadow block type for inputs with a typed-in value. */
  shadow?: string;
  /** The field on that shadow block that holds the value. */
  shadowField?: string;
  receiver?: boolean;
}

export type BlockKind = 'S' | 'R' | 'B' | 'H' | 'C' | 'P';

export interface BlockSpec {
  op: string;
  kind: BlockKind;
  name: string;
  args: ArgSpec[];
}

const RAW = `
S|motion_movesteps|move|STEPS:n
S|motion_turnright|turn_right|DEGREES:n
S|motion_turnleft|turn_left|DEGREES:n
S|motion_goto|go_to|TO:menu/motion_goto_menu/TO
S|motion_gotoxy|go_to_xy|X:n,Y:n
S|motion_glideto|glide_to|SECS:n,TO:menu/motion_glideto_menu/TO
S|motion_glidesecstoxy|glide_to_xy|SECS:n,X:n,Y:n
S|motion_pointindirection|point_in_direction|DIRECTION:n/math_angle
S|motion_pointtowards|point_towards|TOWARDS:menu/motion_pointtowards_menu/TOWARDS
S|motion_changexby|change_x|DX:n
S|motion_setx|set_x|X:n
S|motion_changeyby|change_y|DY:n
S|motion_sety|set_y|Y:n
S|motion_ifonedgebounce|bounce_on_edge|
S|motion_setrotationstyle|set_rotation_style|STYLE:field
R|motion_xposition|x_position|
R|motion_yposition|y_position|
R|motion_direction|direction|
S|looks_sayforsecs|say_for|MESSAGE:s,SECS:n
S|looks_say|say|MESSAGE:s
S|looks_thinkforsecs|think_for|MESSAGE:s,SECS:n
S|looks_think|think|MESSAGE:s
S|looks_switchcostumeto|switch_costume|COSTUME:menu/looks_costume/COSTUME
S|looks_nextcostume|next_costume|
S|looks_switchbackdropto|switch_backdrop|BACKDROP:menu/looks_backdrops/BACKDROP
S|looks_nextbackdrop|next_backdrop|
S|looks_changesizeby|change_size|CHANGE:n
S|looks_setsizeto|set_size|SIZE:n
S|looks_changeeffectby|change_effect|EFFECT:field,CHANGE:n
S|looks_seteffectto|set_effect|EFFECT:field,VALUE:n
S|looks_cleargraphiceffects|clear_effects|
S|looks_show|show|
S|looks_hide|hide|
S|looks_gotofrontback|go_to_layer|FRONT_BACK:field
S|looks_goforwardbackwardlayers|move_layers|FORWARD_BACKWARD:field,NUM:n/math_integer
R|looks_costumenumbername|costume_info|NUMBER_NAME:field
R|looks_backdropnumbername|backdrop_info|NUMBER_NAME:field
R|looks_size|size|
S|sound_playuntildone|play_until_done|SOUND_MENU:menu/sound_sounds_menu/SOUND_MENU
S|sound_play|play_sound|SOUND_MENU:menu/sound_sounds_menu/SOUND_MENU
S|sound_stopallsounds|stop_all_sounds|
S|sound_changeeffectby|change_sound_effect|EFFECT:field,VALUE:n
S|sound_seteffectto|set_sound_effect|EFFECT:field,VALUE:n
S|sound_cleareffects|clear_sound_effects|
S|sound_changevolumeby|change_volume|VOLUME:n
S|sound_setvolumeto|set_volume|VOLUME:n
R|sound_volume|volume|
H|event_whenflagclicked|flag_clicked|
H|event_whenkeypressed|key_pressed|KEY_OPTION:field
H|event_whenthisspriteclicked|sprite_clicked|
H|event_whenstageclicked|stage_clicked|
H|event_whenbackdropswitchesto|backdrop_switches|BACKDROP:field
H|event_whengreaterthan|greater_than|WHENGREATERTHANMENU:field,VALUE:n
H|event_whenbroadcastreceived|broadcast_received|BROADCAST_OPTION:bfield
S|event_broadcast|broadcast|BROADCAST_INPUT:bcast
S|event_broadcastandwait|broadcast_and_wait|BROADCAST_INPUT:bcast
S|control_wait|wait|DURATION:n/math_positive_number
C|control_repeat|repeat|TIMES:n/math_whole_number,SUBSTACK:stack
C|control_forever|forever|SUBSTACK:stack
C|control_if|if|CONDITION:b,SUBSTACK:stack
C|control_if_else|if|CONDITION:b,SUBSTACK:stack,SUBSTACK2:stack
S|control_wait_until|wait_until|CONDITION:b
C|control_repeat_until|until|CONDITION:b,SUBSTACK:stack
S|control_stop|stop|STOP_OPTION:field
H|control_start_as_clone|clone_starts|
S|control_create_clone_of|create_clone|CLONE_OPTION:menu/control_create_clone_of_menu/CLONE_OPTION
P|control_delete_this_clone|delete_clone|
B|sensing_touchingobject|touching|TOUCHINGOBJECTMENU:menu/sensing_touchingobjectmenu/TOUCHINGOBJECTMENU
B|sensing_touchingcolor|touching_color|COLOR:c
B|sensing_coloristouchingcolor|color_touching_color|COLOR:c,COLOR2:c
R|sensing_distanceto|distance_to|DISTANCETOMENU:menu/sensing_distancetomenu/DISTANCETOMENU
S|sensing_askandwait|ask|QUESTION:s
R|sensing_answer|answer|
B|sensing_keypressed|key_down|KEY_OPTION:menu/sensing_keyoptions/KEY_OPTION
B|sensing_mousedown|mouse_down|
R|sensing_mousex|mouse_x|
R|sensing_mousey|mouse_y|
S|sensing_setdragmode|set_drag_mode|DRAG_MODE:field
R|sensing_loudness|loudness|
R|sensing_timer|timer|
S|sensing_resettimer|reset_timer|
R|sensing_of|property_of|PROPERTY:field,OBJECT:menu/sensing_of_object_menu/OBJECT
R|sensing_current|current|CURRENTMENU:field
R|sensing_dayssince2000|days_since_2000|
R|sensing_username|username|
R|operator_add|add|NUM1:n,NUM2:n
R|operator_subtract|subtract|NUM1:n,NUM2:n
R|operator_multiply|multiply|NUM1:n,NUM2:n
R|operator_divide|divide|NUM1:n,NUM2:n
R|operator_mod|mod|NUM1:n,NUM2:n
R|operator_random|random|FROM:n,TO:n
B|operator_gt|gt|OPERAND1:s,OPERAND2:s
B|operator_lt|lt|OPERAND1:s,OPERAND2:s
B|operator_equals|eq|OPERAND1:s,OPERAND2:s
B|operator_and|and|OPERAND1:b,OPERAND2:b
B|operator_or|or|OPERAND1:b,OPERAND2:b
B|operator_not|not|OPERAND:b
R|operator_join|join|STRING1:s,STRING2:s
R|operator_letter_of|letter_of|LETTER:n/math_whole_number,STRING:s
R|operator_length|length_of|STRING:s
B|operator_contains|contains_text|STRING1:s,STRING2:s
R|operator_round|round|NUM:n
R|operator_mathop|math|OPERATOR:field,NUM:n
S|data_showvariable|show_variable|VARIABLE:var
S|data_hidevariable|hide_variable|VARIABLE:var
S|data_addtolist|add|@LIST:list,ITEM:s
S|data_deleteoflist|remove|@LIST:list,INDEX:n/math_integer
S|data_deletealloflist|clear|@LIST:list
S|data_insertatlist|insert|@LIST:list,INDEX:n/math_integer,ITEM:s
S|data_replaceitemoflist|replace|@LIST:list,INDEX:n/math_integer,ITEM:s
R|data_itemoflist|item|@LIST:list,INDEX:n/math_integer
R|data_itemnumoflist|index_of|@LIST:list,ITEM:s
R|data_lengthoflist|length|@LIST:list
B|data_listcontainsitem|contains|@LIST:list,ITEM:s
S|data_showlist|show|@LIST:list
S|data_hidelist|hide|@LIST:list
`;

function parseArg(text: string): ArgSpec {
  let receiver = false;
  if (text.startsWith('@')) {
    receiver = true;
    text = text.slice(1);
  }
  const [name, type] = text.split(':');
  const [kind, a, b] = type.split('/');
  const spec: ArgSpec = { name, kind: kind as ArgKind };
  if (receiver) spec.receiver = true;
  if (kind === 'n') {
    spec.shadow = a ?? 'math_number';
    spec.shadowField = 'NUM';
  } else if (kind === 's') {
    spec.shadow = 'text';
    spec.shadowField = 'TEXT';
  } else if (kind === 'c') {
    spec.shadow = 'colour_picker';
    spec.shadowField = 'COLOUR';
  } else if (kind === 'menu') {
    spec.kind = 'menu';
    spec.shadow = a;
    spec.shadowField = b;
  }
  return spec;
}

export const BLOCKS: BlockSpec[] = RAW.trim()
  .split('\n')
  .map((line) => {
    const [kind, op, name, args] = line.split('|');
    return { op, kind: kind as BlockKind, name, args: args ? args.split(',').map(parseArg) : [] };
  });

export const BY_OP = new Map<string, BlockSpec>(BLOCKS.map((b) => [b.op, b]));

/** Operators written between two values: a + b. Higher number binds tighter. */
export const INFIX: Record<string, { sym: string; csharp: string; python: string; prec: number }> = {
  operator_or: { sym: 'or', csharp: '||', python: 'or', prec: 1 },
  operator_and: { sym: 'and', csharp: '&&', python: 'and', prec: 2 },
  operator_equals: { sym: 'eq', csharp: '==', python: '==', prec: 4 },
  operator_gt: { sym: 'gt', csharp: '>', python: '>', prec: 4 },
  operator_lt: { sym: 'lt', csharp: '<', python: '<', prec: 4 },
  operator_add: { sym: 'add', csharp: '+', python: '+', prec: 5 },
  operator_subtract: { sym: 'subtract', csharp: '-', python: '-', prec: 5 },
  operator_multiply: { sym: 'multiply', csharp: '*', python: '*', prec: 6 },
  operator_divide: { sym: 'divide', csharp: '/', python: '/', prec: 6 },
  operator_mod: { sym: 'mod', csharp: '%', python: '%', prec: 6 },
};
export const NOT_PREC = 3;

/** Operator symbol (any accepted spelling) to opcode. */
export const INFIX_BY_SYMBOL = new Map<string, string>();
for (const [op, info] of Object.entries(INFIX)) {
  INFIX_BY_SYMBOL.set(info.csharp, op);
  INFIX_BY_SYMBOL.set(info.python, op);
}

export const KEYWORDS = new Set([
  'when', 'if', 'else', 'repeat', 'forever', 'until', 'var', 'list', 'local', 'global', 'cloud',
  'define', 'void', 'def', 'string', 'bool', 'true', 'false', 'and', 'or', 'not', 'warp', 'block',
  'loose', 'pass', 'default', 'None', 'elif',
]);

// ---- names in each skin -------------------------------------------------------------

export type Skin = 'csharp' | 'python';

const pascal = (snake: string): string =>
  snake
    .split('_')
    .map((w) => (w === 'xy' ? 'XY' : w === 'x' || w === 'y' ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');

export const skinName = (snake: string, skin: Skin): string => (skin === 'csharp' ? pascal(snake) : snake);

/** Name a custom block gets from its Scratch label: "jump high %s" -> jump_high. */
export function procBaseName(proccode: string): string {
  const words = proccode
    .replace(/%[sb]/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const name = words.join('_');
  return /^[a-z_]/.test(name) ? name : `block_${name}`;
}
