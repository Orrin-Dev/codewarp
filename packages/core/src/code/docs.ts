import { BLOCKS, type BlockSpec, type Skin, skinName } from './spec';

/** What each block is called in Scratch, and what it does. "label | description" */
const DOCS: Record<string, string> = {
  motion_movesteps: 'move (10) steps | Moves the sprite forward in the direction it faces.',
  motion_turnright: 'turn ↻ (15) degrees | Turns the sprite clockwise.',
  motion_turnleft: 'turn ↺ (15) degrees | Turns the sprite counter-clockwise.',
  motion_goto: 'go to [random position v] | Jumps to the mouse pointer, a random spot, or another sprite. Use "_mouse_", "_random_" or a sprite name.',
  motion_gotoxy: 'go to x: () y: () | Jumps to an exact position.',
  motion_glideto: 'glide (1) secs to [random position v] | Slides to the mouse, a random spot or a sprite over some seconds.',
  motion_glidesecstoxy: 'glide (1) secs to x: () y: () | Slides to an exact position over some seconds.',
  motion_pointindirection: 'point in direction (90) | Turns to face an angle (0 up, 90 right, 180 down, -90 left).',
  motion_pointtowards: 'point towards [mouse-pointer v] | Turns to face the mouse or another sprite.',
  motion_changexby: 'change x by (10) | Moves sideways by this much.',
  motion_setx: 'set x to (0) | Puts the sprite at this x position.',
  motion_changeyby: 'change y by (10) | Moves up or down by this much.',
  motion_sety: 'set y to (0) | Puts the sprite at this y position.',
  motion_ifonedgebounce: 'if on edge, bounce | Turns around when the sprite touches the edge of the stage.',
  motion_setrotationstyle: 'set rotation style [left-right v] | "left-right", "don\'t rotate" or "all around".',
  motion_xposition: '(x position) | The sprite\'s x position.',
  motion_yposition: '(y position) | The sprite\'s y position.',
  motion_direction: '(direction) | The angle the sprite faces.',
  looks_sayforsecs: 'say [Hello!] for (2) seconds | Shows a speech bubble for some seconds, then waits.',
  looks_say: 'say [Hello!] | Shows a speech bubble until it is replaced.',
  looks_thinkforsecs: 'think [Hmm...] for (2) seconds | Shows a thought bubble for some seconds, then waits.',
  looks_think: 'think [Hmm...] | Shows a thought bubble until it is replaced.',
  looks_switchcostumeto: 'switch costume to [costume1 v] | Changes to the costume with this name.',
  looks_nextcostume: 'next costume | Changes to the next costume.',
  looks_switchbackdropto: 'switch backdrop to [backdrop1 v] | Changes the stage backdrop.',
  looks_nextbackdrop: 'next backdrop | Changes to the next backdrop.',
  looks_changesizeby: 'change size by (10) | Makes the sprite bigger or smaller.',
  looks_setsizeto: 'set size to (100) % | Sets the size as a percentage.',
  looks_changeeffectby: 'change [color v] effect by (25) | Adds to a visual effect ("COLOR", "FISHEYE", "WHIRL", "PIXELATE", "MOSAIC", "BRIGHTNESS", "GHOST").',
  looks_seteffectto: 'set [color v] effect to (0) | Sets a visual effect to an exact amount.',
  looks_cleargraphiceffects: 'clear graphic effects | Removes every visual effect.',
  looks_show: 'show | Makes the sprite visible.',
  looks_hide: 'hide | Makes the sprite invisible.',
  looks_gotofrontback: 'go to [front v] layer | Moves the sprite to the "front" or "back".',
  looks_goforwardbackwardlayers: 'go [forward v] (1) layers | Moves the sprite "forward" or "backward" through the layers.',
  looks_costumenumbername: '(costume [number v]) | The costume\'s "number" or "name".',
  looks_backdropnumbername: '(backdrop [number v]) | The backdrop\'s "number" or "name".',
  looks_size: '(size) | The sprite\'s size in percent.',
  sound_playuntildone: 'play sound [Meow v] until done | Plays a sound and waits for it to finish.',
  sound_play: 'start sound [Meow v] | Starts a sound and carries on straight away.',
  sound_stopallsounds: 'stop all sounds | Silences every sound.',
  sound_changeeffectby: 'change [pitch v] effect by (10) | Adds to the "PITCH" or "PAN" effect.',
  sound_seteffectto: 'set [pitch v] effect to (100) | Sets the "PITCH" or "PAN" effect.',
  sound_cleareffects: 'clear sound effects | Removes sound effects.',
  sound_changevolumeby: 'change volume by (-10) | Makes sounds louder or quieter.',
  sound_setvolumeto: 'set volume to (100) % | Sets the volume.',
  sound_volume: '(volume) | The current volume.',
  event_whenflagclicked: 'when green flag clicked | Starts the script when the green flag is pressed.',
  event_whenkeypressed: 'when [space v] key pressed | Starts the script when a key is pressed. Use "space", "a", "up arrow", "any"...',
  event_whenthisspriteclicked: 'when this sprite clicked | Starts the script when the sprite is clicked.',
  event_whenstageclicked: 'when stage clicked | Starts the script when the stage is clicked.',
  event_whenbackdropswitchesto: 'when backdrop switches to [backdrop1 v] | Starts the script when the backdrop changes to this one.',
  event_whengreaterthan: 'when [loudness v] > (10) | Starts the script when the "LOUDNESS" or "TIMER" goes above a number.',
  event_whenbroadcastreceived: 'when I receive [message1 v] | Starts the script when this message is broadcast.',
  event_broadcast: 'broadcast [message1 v] | Sends a message to every sprite and carries on.',
  event_broadcastandwait: 'broadcast [message1 v] and wait | Sends a message and waits until every script it started has finished.',
  control_wait: 'wait (1) seconds | Pauses the script.',
  control_repeat: 'repeat (10) | Runs the blocks inside a number of times.',
  control_forever: 'forever | Runs the blocks inside again and again.',
  control_if: 'if <> then | Runs the blocks inside only when the condition is true.',
  control_if_else: 'if <> then ... else | Runs one set of blocks when the condition is true, another when it is not. "else if" chains work too.',
  control_wait_until: 'wait until <> | Pauses until the condition becomes true.',
  control_repeat_until: 'repeat until <> | Repeats the blocks inside until the condition becomes true.',
  control_stop: 'stop [all v] | Stops "all", "this script" or "other scripts in sprite".',
  control_start_as_clone: 'when I start as a clone | Starts the script on every new clone.',
  control_create_clone_of: 'create clone of [myself v] | Makes a copy of this or another sprite. Use "_myself_" or a sprite name.',
  control_delete_this_clone: 'delete this clone | Removes this clone.',
  sensing_touchingobject: '<touching [mouse-pointer v]?> | True when the sprite touches "_mouse_", "_edge_" or another sprite.',
  sensing_touchingcolor: '<touching color [ ]?> | True when the sprite touches this colour, written like "#ff0000".',
  sensing_coloristouchingcolor: '<color [ ] is touching [ ]?> | True when the first colour on the sprite touches the second colour.',
  sensing_distanceto: '(distance to [mouse-pointer v]) | How far the sprite is from the mouse or another sprite.',
  sensing_askandwait: 'ask [What\'s your name?] and wait | Shows a question and waits for a typed answer.',
  sensing_answer: '(answer) | What was typed for the last question.',
  sensing_keypressed: '<key [space v] pressed?> | True while a key is held down.',
  sensing_mousedown: '<mouse down?> | True while the mouse button is held down.',
  sensing_mousex: '(mouse x) | The mouse pointer\'s x position.',
  sensing_mousey: '(mouse y) | The mouse pointer\'s y position.',
  sensing_setdragmode: 'set drag mode [draggable v] | "draggable" or "not draggable" while the project runs.',
  sensing_loudness: '(loudness) | How loud the microphone is.',
  sensing_timer: '(timer) | Seconds since the timer was reset.',
  sensing_resettimer: 'reset timer | Sets the timer back to 0.',
  sensing_of: '([x position v] of [Sprite1 v]) | Reads a property (like "x position" or a variable name) of another sprite.',
  sensing_current: '(current [year v]) | The current "YEAR", "MONTH", "DATE", "DAYOFWEEK", "HOUR", "MINUTE" or "SECOND".',
  sensing_dayssince2000: '(days since 2000) | Days since 1 January 2000.',
  sensing_username: '(username) | The name of the person running the project.',
  operator_add: '(() + ()) | Adds two numbers. Written a + b.',
  operator_subtract: '(() - ()) | Subtracts. Written a - b.',
  operator_multiply: '(() * ()) | Multiplies. Written a * b.',
  operator_divide: '(() / ()) | Divides. Written a / b.',
  operator_mod: '(() mod ()) | The remainder after dividing. Written a % b.',
  operator_random: '(pick random (1) to (10)) | A random whole number between two numbers.',
  operator_gt: '<() > ()> | True when the first is bigger. Written a > b.',
  operator_lt: '<() < ()> | True when the first is smaller. Written a < b.',
  operator_equals: '<() = ()> | True when both are equal. Written a == b. (a != b, a <= b and a >= b work too.)',
  operator_and: '<<> and <>> | True when both are true. Written a && b (C#) or a and b (Python).',
  operator_or: '<<> or <>> | True when either is true. Written a || b (C#) or a or b (Python).',
  operator_not: '<not <>> | Flips true and false. Written !a (C#) or not a (Python).',
  operator_join: '(join [apple ] [banana]) | Sticks two pieces of text together.',
  operator_letter_of: '(letter (1) of [apple]) | One letter of some text (counting from 1).',
  operator_length: '(length of [apple]) | How many letters are in some text.',
  operator_contains: '<[apple] contains [a]?> | True when the first text contains the second.',
  operator_round: '(round ()) | Rounds to the nearest whole number.',
  operator_mathop: '([abs v] of ()) | A math function: "abs", "floor", "ceiling", "sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "ln", "log", "e ^", "10 ^".',
  data_showvariable: 'show variable [my variable v] | Shows the variable on the stage.',
  data_hidevariable: 'hide variable [my variable v] | Hides the variable from the stage.',
  data_addtolist: 'add [thing] to [list v] | Adds an item to the end of the list.',
  data_deleteoflist: 'delete (1) of [list v] | Removes an item. Use "all" or "last" too.',
  data_deletealloflist: 'delete all of [list v] | Empties the list.',
  data_insertatlist: 'insert [thing] at (1) of [list v] | Puts an item at a position in the list.',
  data_replaceitemoflist: 'replace item (1) of [list v] with [thing] | Changes one item of the list.',
  data_itemoflist: '(item (1) of [list v]) | Reads one item of the list (counting from 1).',
  data_itemnumoflist: '(item # of [thing] in [list v]) | Where an item is in the list (0 when it is not there).',
  data_lengthoflist: '(length of [list v]) | How many items the list has.',
  data_listcontainsitem: '<[list v] contains [thing]?> | True when the list has this item.',
  data_showlist: 'show list [list v] | Shows the list on the stage.',
  data_hidelist: 'hide list [list v] | Hides the list from the stage.',
};

/** Blocks that are written with special syntax rather than a plain call. */
export const EXTRA_DOCS: { op: string; csharp: string; python: string; label: string; desc: string; category: string }[] = [
  { op: 'data_setvariableto', csharp: 'score = 0;', python: 'score = 0', label: 'set [score v] to (0)', desc: 'Puts a value in a variable. Declare variables at the top with var score;', category: 'Variables' },
  { op: 'data_changevariableby', csharp: 'score += 1;', python: 'score += 1', label: 'change [score v] by (1)', desc: 'Adds to a variable (use a negative number to subtract).', category: 'Variables' },
  { op: 'data_variable', csharp: 'score', python: 'score', label: '(score)', desc: 'A variable used as a value. Names with spaces go in backticks: `my variable`.', category: 'Variables' },
  { op: 'data_listcontents', csharp: 'items', python: 'items', label: '(list)', desc: 'A whole list used as a value (declare it with list items;).', category: 'Variables' },
  { op: 'procedures_definition', csharp: 'void Jump(string height, bool high) {\n    ...\n}', python: 'def jump(height, high: bool):\n    ...', label: 'define jump (height) <high>', desc: 'Makes your own block. Add [Warp] (C#) or @warp (Python) above it for "run without screen refresh". [Block("label %s")] / @block("label %s") sets the exact Scratch label.', category: 'My Blocks' },
  { op: 'procedures_call', csharp: 'Jump(10, score > 3);', python: 'jump(10, score > 3)', label: 'jump (10) <>', desc: 'Runs one of your own blocks. Text and number slots take any value, true/false slots take a condition.', category: 'My Blocks' },
  { op: 'control_repeat', csharp: 'repeat (10) {\n    ...\n}', python: 'repeat 10:\n    ...', label: 'repeat (10)', desc: 'Runs the lines inside a number of times.', category: 'Control' },
  { op: 'control_forever', csharp: 'forever {\n    ...\n}', python: 'forever:\n    ...', label: 'forever', desc: 'Runs the lines inside again and again.', category: 'Control' },
  { op: 'control_if', csharp: 'if (score > 5) {\n    ...\n}', python: 'if score > 5:\n    ...', label: 'if <> then', desc: 'Runs the lines inside only when the condition is true.', category: 'Control' },
  { op: 'control_if_else', csharp: 'if (score > 5) {\n    ...\n} else if (score > 2) {\n    ...\n} else {\n    ...\n}', python: 'if score > 5:\n    ...\nelif score > 2:\n    ...\nelse:\n    ...', label: 'if <> then ... else', desc: 'Picks between blocks. "else if" chains nest if/else blocks.', category: 'Control' },
  { op: 'control_repeat_until', csharp: 'until (score > 9) {\n    ...\n}', python: 'until score > 9:\n    ...', label: 'repeat until <>', desc: 'Repeats the lines inside until the condition becomes true.', category: 'Control' },
];

export const CATEGORIES = ['Motion', 'Looks', 'Sound', 'Events', 'Control', 'Sensing', 'Operators', 'Variables', 'My Blocks'];

export function categoryOf(op: string): string {
  const prefix = op.split('_')[0];
  return { motion: 'Motion', looks: 'Looks', sound: 'Sound', event: 'Events', control: 'Control', sensing: 'Sensing', operator: 'Operators', data: 'Variables', procedures: 'My Blocks' }[prefix] ?? 'Other';
}

export interface Doc {
  op: string;
  category: string;
  /** How it looks as a Scratch block, e.g. "move (10) steps". */
  label: string;
  desc: string;
  /** Example code in each style. */
  csharp: string;
  python: string;
  kind: 'statement' | 'value' | 'condition' | 'event' | 'other';
}

const split = (op: string): { label: string; desc: string } => {
  const [label, ...rest] = (DOCS[op] ?? `${op} | `).split(' | ');
  return { label, desc: rest.join(' | ') };
};

const SAMPLE: Record<string, string> = { n: '10', s: '"hello"', c: '"#ff0000"', b: 'score > 3', menu: '"_random_"', field: '"..."', bfield: '"message1"', bcast: '"message1"' };

function example(spec: BlockSpec, skin: Skin): string {
  const name = skinName(spec.name, skin);
  const recv = spec.args.find((a) => a.receiver);
  const rest = spec.args.filter((a) => !a.receiver);
  const sample = (a: (typeof rest)[number]): string => (a.kind === 'var' ? 'score' : a.kind === 'list' ? 'items' : SAMPLE[a.kind] ?? '0');
  let call = `${name}(${rest.map(sample).join(', ')})`;
  if (recv) call = `items.${call}`;
  if (spec.kind === 'H') return skin === 'csharp' ? `when ${rest.length ? call : name} {\n    ...\n}` : `when ${rest.length ? call : name}:\n    ...`;
  if (spec.kind === 'S' || spec.kind === 'P') return skin === 'csharp' ? `${call};` : call;
  return call;
}

export function allDocs(): Doc[] {
  const docs: Doc[] = [];
  for (const spec of BLOCKS) {
    if (spec.kind === 'C') continue;
    const { label, desc } = split(spec.op);
    docs.push({
      op: spec.op,
      category: categoryOf(spec.op),
      label,
      desc,
      csharp: example(spec, 'csharp'),
      python: example(spec, 'python'),
      kind: spec.kind === 'H' ? 'event' : spec.kind === 'R' ? 'value' : spec.kind === 'B' ? 'condition' : 'statement',
    });
  }
  for (const e of EXTRA_DOCS) {
    docs.push({ op: e.op, category: e.category, label: e.label, desc: e.desc, csharp: e.csharp, python: e.python, kind: e.op.startsWith('control_') || e.op === 'procedures_definition' ? 'other' : e.op === 'data_variable' || e.op === 'data_listcontents' ? 'value' : 'statement' });
  }
  return docs;
}

/** The basics of the syntax, shown at the top of the Code Bank. */
export const BASICS: { title: string; desc: string; csharp: string; python: string }[] = [
  {
    title: 'Scripts',
    desc: 'Every script starts with an event (a hat block) or a custom block definition. The lines inside run top to bottom. Leave a blank line between scripts.',
    csharp: 'when FlagClicked {\n    Move(10);\n}',
    python: 'when flag_clicked:\n    move(10)',
  },
  {
    title: 'Variables and lists',
    desc: 'Declare them at the top. "local" belongs to this sprite only, otherwise it is shared by all sprites. Use "cloud" for cloud variables. Names with spaces go in `backticks`.',
    csharp: 'var score;\nlocal var speed;\nlist items;\nvar `my variable`;',
    python: 'var score\nlocal var speed\nlist items\nvar `my variable`',
  },
  {
    title: 'Changing variables',
    desc: '= is "set to", += is "change by". Lists use methods: items.Add(x), items.Item(1), items.Length().',
    csharp: 'score = 0;\nscore += 1;\nitems.Add(score);',
    python: 'score = 0\nscore += 1\nitems.add(score)',
  },
  {
    title: 'Values',
    desc: 'Numbers are written plainly, text goes in "quotes". Colours are text like "#ff0000". Sprite, costume and sound names are text too. Menu choices like "_mouse_" and "_random_" are text.',
    csharp: 'Say("Hello", 2);\nSetSize(150);\nGoTo("_mouse_");',
    python: 'say_for("Hello", 2)\nset_size(150)\ngo_to("_mouse_")',
  },
  {
    title: 'Maths and conditions',
    desc: 'Use + - * / % for maths, == != < > <= >= to compare, and && || ! (C#) or and or not (Python) to combine true/false values. Use brackets to group.',
    csharp: 'if (x_position > 100 && !MouseDown()) {\n    Say(score * 2 + 1);\n}',
    python: 'if x_position > 100 and not mouse_down():\n    say(score * 2 + 1)',
  },
  {
    title: 'Loops',
    desc: 'repeat runs a number of times, forever never stops, until repeats until the condition becomes true.',
    csharp: 'repeat (10) { Move(5); }\nforever { TurnRight(1); }\nuntil (MouseDown()) { Wait(1); }',
    python: 'repeat 10:\n    move(5)\nforever:\n    turn_right(1)\nuntil mouse_down():\n    wait(1)',
  },
  {
    title: 'Empty slots',
    desc: 'Leave a true/false slot empty with default (C#) or None (Python).',
    csharp: 'if (default) {\n    Move(10);\n}',
    python: 'if None:\n    move(10)',
  },
  {
    title: 'Comments',
    desc: 'Comments are ignored. Lines starting with "kept:" stand for scripts that use blocks text mode cannot write yet (like pen blocks). Delete that line to delete the script.',
    csharp: '// this is a comment\n// kept: abc123 (pen_clear)',
    python: '# this is a comment\n# kept: abc123 (pen_clear)',
  },
];
