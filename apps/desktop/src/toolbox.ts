/**
 * The block palette, the same sections and blocks as the Scratch editor (minus extensions).
 * Block opcodes are the standard Scratch 3 opcodes. Menus that depend on the project (costumes,
 * sounds, sprites) are filled in by menus.ts.
 */

const num = (name: string, value: number | string, type = 'math_number'): string =>
  `<value name="${name}"><shadow type="${type}"><field name="NUM">${value}</field></shadow></value>`;
const text = (name: string, value: string): string =>
  `<value name="${name}"><shadow type="text"><field name="TEXT">${value}</field></shadow></value>`;
const menu = (name: string, type: string, field?: string, value?: string): string =>
  `<value name="${name}"><shadow type="${type}">${field ? `<field name="${field}">${value ?? ''}</field>` : ''}</shadow></value>`;
const colour = (name: string, value: string): string =>
  `<value name="${name}"><shadow type="colour_picker"><field name="COLOUR">${value}</field></shadow></value>`;
const block = (type: string, inner = ''): string => `<block type="${type}">${inner}</block>`;
const gap = '<sep gap="36"></sep>';

const motion = [
  block('motion_movesteps', num('STEPS', 10)),
  block('motion_turnright', num('DEGREES', 15)),
  block('motion_turnleft', num('DEGREES', 15)),
  gap,
  block('motion_goto', menu('TO', 'motion_goto_menu')),
  block('motion_gotoxy', num('X', 0) + num('Y', 0)),
  block('motion_glideto', num('SECS', 1) + menu('TO', 'motion_glideto_menu')),
  block('motion_glidesecstoxy', num('SECS', 1) + num('X', 0) + num('Y', 0)),
  gap,
  block('motion_pointindirection', num('DIRECTION', 90, 'math_angle')),
  block('motion_pointtowards', menu('TOWARDS', 'motion_pointtowards_menu')),
  gap,
  block('motion_changexby', num('DX', 10)),
  block('motion_setx', num('X', 0)),
  block('motion_changeyby', num('DY', 10)),
  block('motion_sety', num('Y', 0)),
  gap,
  block('motion_ifonedgebounce'),
  gap,
  block('motion_setrotationstyle'),
  gap,
  block('motion_xposition'),
  block('motion_yposition'),
  block('motion_direction'),
].join('');

const looks = [
  block('looks_sayforsecs', text('MESSAGE', 'Hello!') + num('SECS', 2)),
  block('looks_say', text('MESSAGE', 'Hello!')),
  block('looks_thinkforsecs', text('MESSAGE', 'Hmm...') + num('SECS', 2)),
  block('looks_think', text('MESSAGE', 'Hmm...')),
  gap,
  block('looks_switchcostumeto', menu('COSTUME', 'looks_costume')),
  block('looks_nextcostume'),
  block('looks_switchbackdropto', menu('BACKDROP', 'looks_backdrops')),
  block('looks_nextbackdrop'),
  gap,
  block('looks_changesizeby', num('CHANGE', 10)),
  block('looks_setsizeto', num('SIZE', 100)),
  gap,
  block('looks_changeeffectby', num('CHANGE', 25)),
  block('looks_seteffectto', num('VALUE', 0)),
  block('looks_cleargraphiceffects'),
  gap,
  block('looks_show'),
  block('looks_hide'),
  gap,
  block('looks_gotofrontback'),
  block('looks_goforwardbackwardlayers', num('NUM', 1, 'math_integer')),
  gap,
  block('looks_costumenumbername'),
  block('looks_backdropnumbername'),
  block('looks_size'),
].join('');

const sound = [
  block('sound_playuntildone', menu('SOUND_MENU', 'sound_sounds_menu')),
  block('sound_play', menu('SOUND_MENU', 'sound_sounds_menu')),
  block('sound_stopallsounds'),
  gap,
  block('sound_changeeffectby', num('VALUE', 10)),
  block('sound_seteffectto', num('VALUE', 100)),
  block('sound_cleareffects'),
  gap,
  block('sound_changevolumeby', num('VOLUME', -10)),
  block('sound_setvolumeto', num('VOLUME', 100)),
  block('sound_volume'),
].join('');

const events = [
  block('event_whenflagclicked'),
  block('event_whenkeypressed'),
  block('event_whenthisspriteclicked'),
  block('event_whenstageclicked'),
  block('event_whenbackdropswitchesto'),
  gap,
  block('event_whengreaterthan', num('VALUE', 10)),
  gap,
  block('event_whenbroadcastreceived'),
  block('event_broadcast', menu('BROADCAST_INPUT', 'event_broadcast_menu')),
  block('event_broadcastandwait', menu('BROADCAST_INPUT', 'event_broadcast_menu')),
].join('');

const control = [
  block('control_wait', num('DURATION', 1, 'math_positive_number')),
  gap,
  block('control_repeat', num('TIMES', 10, 'math_whole_number')),
  block('control_forever'),
  gap,
  block('control_if'),
  block('control_if_else'),
  block('control_wait_until'),
  block('control_repeat_until'),
  gap,
  block('control_stop'),
  gap,
  block('control_start_as_clone'),
  block('control_create_clone_of', menu('CLONE_OPTION', 'control_create_clone_of_menu')),
  block('control_delete_this_clone'),
].join('');

const sensing = [
  block('sensing_touchingobject', menu('TOUCHINGOBJECTMENU', 'sensing_touchingobjectmenu')),
  block('sensing_touchingcolor', colour('COLOR', '#55b8ff')),
  block('sensing_coloristouchingcolor', colour('COLOR', '#d0a050') + colour('COLOR2', '#d0a050')),
  block('sensing_distanceto', menu('DISTANCETOMENU', 'sensing_distancetomenu')),
  gap,
  block('sensing_askandwait', text('QUESTION', "What's your name?")),
  block('sensing_answer'),
  gap,
  block('sensing_keypressed', menu('KEY_OPTION', 'sensing_keyoptions')),
  block('sensing_mousedown'),
  block('sensing_mousex'),
  block('sensing_mousey'),
  block('sensing_setdragmode'),
  gap,
  block('sensing_loudness'),
  gap,
  block('sensing_timer'),
  block('sensing_resettimer'),
  gap,
  block('sensing_of', menu('OBJECT', 'sensing_of_object_menu')),
  gap,
  block('sensing_current'),
  block('sensing_dayssince2000'),
  gap,
  block('sensing_username'),
].join('');

const operators = [
  block('operator_add', num('NUM1', '') + num('NUM2', '')),
  block('operator_subtract', num('NUM1', '') + num('NUM2', '')),
  block('operator_multiply', num('NUM1', '') + num('NUM2', '')),
  block('operator_divide', num('NUM1', '') + num('NUM2', '')),
  gap,
  block('operator_random', num('FROM', 1) + num('TO', 10)),
  gap,
  block('operator_gt', text('OPERAND1', '') + text('OPERAND2', '50')),
  block('operator_lt', text('OPERAND1', '') + text('OPERAND2', '50')),
  block('operator_equals', text('OPERAND1', '') + text('OPERAND2', '50')),
  gap,
  block('operator_and'),
  block('operator_or'),
  block('operator_not'),
  gap,
  block('operator_join', text('STRING1', 'apple ') + text('STRING2', 'banana')),
  block('operator_letter_of', num('LETTER', 1, 'math_whole_number') + text('STRING', 'apple')),
  block('operator_length', text('STRING', 'apple')),
  block('operator_contains', text('STRING1', 'apple') + text('STRING2', 'a')),
  gap,
  block('operator_mod', num('NUM1', '') + num('NUM2', '')),
  block('operator_round', num('NUM', '')),
  gap,
  block('operator_mathop', num('NUM', '')),
].join('');


// The stage cannot move, talk, be touched or be cloned, so it gets a smaller palette (like in Scratch).
const stageLooks = [
  block('looks_switchbackdropto', menu('BACKDROP', 'looks_backdrops')),
  block('looks_nextbackdrop'),
  gap,
  block('looks_changeeffectby', num('CHANGE', 25)),
  block('looks_seteffectto', num('VALUE', 0)),
  block('looks_cleargraphiceffects'),
  gap,
  block('looks_backdropnumbername'),
].join('');

const stageEvents = [
  block('event_whenflagclicked'),
  block('event_whenkeypressed'),
  block('event_whenstageclicked'),
  block('event_whenbackdropswitchesto'),
  gap,
  block('event_whengreaterthan', num('VALUE', 10)),
  gap,
  block('event_whenbroadcastreceived'),
  block('event_broadcast', menu('BROADCAST_INPUT', 'event_broadcast_menu')),
  block('event_broadcastandwait', menu('BROADCAST_INPUT', 'event_broadcast_menu')),
].join('');

const stageControl = [
  block('control_wait', num('DURATION', 1, 'math_positive_number')),
  gap,
  block('control_repeat', num('TIMES', 10, 'math_whole_number')),
  block('control_forever'),
  gap,
  block('control_if'),
  block('control_if_else'),
  block('control_wait_until'),
  block('control_repeat_until'),
  gap,
  block('control_stop'),
  gap,
  block('control_create_clone_of', menu('CLONE_OPTION', 'control_create_clone_of_menu')),
].join('');

const stageSensing = [
  block('sensing_askandwait', text('QUESTION', "What's your name?")),
  block('sensing_answer'),
  gap,
  block('sensing_keypressed', menu('KEY_OPTION', 'sensing_keyoptions')),
  block('sensing_mousedown'),
  block('sensing_mousex'),
  block('sensing_mousey'),
  gap,
  block('sensing_loudness'),
  gap,
  block('sensing_timer'),
  block('sensing_resettimer'),
  gap,
  block('sensing_of', menu('OBJECT', 'sensing_of_object_menu')),
  gap,
  block('sensing_current'),
  block('sensing_dayssince2000'),
  gap,
  block('sensing_username'),
].join('');

/** The palette for the sprite being edited, or for the stage. */
export function buildToolbox(stage: boolean): string {
  return `
<xml id="toolbox-categories" style="display: none">
  ${stage ? '' : `<category name="Motion" id="motion" colour="#4C97FF" secondaryColour="#3373CC">${motion}</category>`}
  <category name="Looks" id="looks" colour="#9966FF" secondaryColour="#774DCB">${stage ? stageLooks : looks}</category>
  <category name="Sound" id="sound" colour="#CF63CF" secondaryColour="#BD42BD">${sound}</category>
  <category name="Events" id="events" colour="#FFBF00" secondaryColour="#CC9900">${stage ? stageEvents : events}</category>
  <category name="Control" id="control" colour="#FFAB19" secondaryColour="#CF8B17">${stage ? stageControl : control}</category>
  <category name="Sensing" id="sensing" colour="#5CB1D6" secondaryColour="#2E8EB8">${stage ? stageSensing : sensing}</category>
  <category name="Operators" id="operators" colour="#59C059" secondaryColour="#389438">${operators}</category>
  <category name="Variables" id="variables" colour="#FF8C1A" secondaryColour="#DB6E00" custom="VARIABLE"></category>
  <category name="My Blocks" id="myBlocks" colour="#FF6680" secondaryColour="#FF4D6A" custom="PROCEDURE"></category>
</xml>
`;
}

export const TOOLBOX_XML = buildToolbox(false);
export const STAGE_TOOLBOX_XML = buildToolbox(true);
