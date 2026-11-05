/**
 * Minimal block palette. scratch-gui generates a much larger toolbox
 * (make-toolbox-xml.js); we start small and grow it as features land.
 * Block opcodes are the standard Scratch 3 opcodes.
 */
export const TOOLBOX_XML = `
<xml id="toolbox-categories" style="display: none">
  <category name="Motion" id="motion" colour="#4C97FF" secondaryColour="#3373CC">
    <block type="motion_movesteps">
      <value name="STEPS"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    </block>
    <block type="motion_turnright">
      <value name="DEGREES"><shadow type="math_number"><field name="NUM">15</field></shadow></value>
    </block>
    <block type="motion_turnleft">
      <value name="DEGREES"><shadow type="math_number"><field name="NUM">15</field></shadow></value>
    </block>
    <block type="motion_gotoxy">
      <value name="X"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
      <value name="Y"><shadow type="math_number"><field name="NUM">0</field></shadow></value>
    </block>
  </category>
  <category name="Looks" id="looks" colour="#9966FF" secondaryColour="#774DCB">
    <block type="looks_sayforsecs">
      <value name="MESSAGE"><shadow type="text"><field name="TEXT">Hello!</field></shadow></value>
      <value name="SECS"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
    </block>
    <block type="looks_say">
      <value name="MESSAGE"><shadow type="text"><field name="TEXT">Hello!</field></shadow></value>
    </block>
    <block type="looks_show"></block>
    <block type="looks_hide"></block>
  </category>
  <category name="Events" id="events" colour="#FFD500" secondaryColour="#CC9900">
    <block type="event_whenflagclicked"></block>
    <block type="event_whenkeypressed"></block>
    <block type="event_whenthisspriteclicked"></block>
    <block type="event_broadcast">
      <value name="BROADCAST_INPUT"><shadow type="event_broadcast_menu"></shadow></value>
    </block>
  </category>
  <category name="Control" id="control" colour="#FFAB19" secondaryColour="#CF8B17">
    <block type="control_wait">
      <value name="DURATION"><shadow type="math_positive_number"><field name="NUM">1</field></shadow></value>
    </block>
    <block type="control_repeat">
      <value name="TIMES"><shadow type="math_whole_number"><field name="NUM">10</field></shadow></value>
    </block>
    <block type="control_forever"></block>
    <block type="control_if"></block>
    <block type="control_if_else"></block>
  </category>
  <category name="Variables" id="variables" colour="#FF8C1A" secondaryColour="#DB6E00" custom="VARIABLE"></category>
  <category name="My Blocks" id="myBlocks" colour="#FF6680" secondaryColour="#FF4D6A" custom="PROCEDURE"></category>
</xml>
`;
