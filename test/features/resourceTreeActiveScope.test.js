const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readSource } = require("../_helpers/sourceReader");

const panel = readSource("src/ui/PanelHtml.ts");

test("resource tree active lookup ignores duplicate jump buttons outside the tree", () => {
  assert.match(panel, /data-section-target="settings" data-anchor-target="settings"/);
  assert.match(panel, /function resourceTreeActiveSelector\(section, anchor\) \{\s*return '#resourceTree \[data-section-target="'/);
  assert.match(panel, /document\.querySelector\(resourceTreeActiveSelector\(activeResourceSection, activeResourceAnchor\)\)/);
});

test("resource tree reuses immutable icon and tone rank tables", () => {
  assert.match(panel, /const RESOURCE_TREE_SECTION_ICONS = Object\.freeze\(\{ servers: "▧", gpu: "◫"/);
  assert.match(panel, /const RESOURCE_TREE_TONE_RANKS = Object\.freeze\(\{ error: 5, warn: 4, mine: 3, good: 2, info: 1 \}\)/);
  assert.match(panel, /return RESOURCE_TREE_SECTION_ICONS\[section\] \|\| "•"/);
  assert.match(panel, /RESOURCE_TREE_TONE_RANKS\[b\][\s\S]{0,80}RESOURCE_TREE_TONE_RANKS\[a\]/);
  assert.doesNotMatch(panel, /function defaultTreeObjectIcon\(section\) \{\s*const map =/);
  assert.doesNotMatch(panel, /function resourceTreeDominantTone\(tones\) \{\s*const rank =/);
});

test("resource tree help and inspector labels reuse immutable maps", () => {
  assert.match(panel, /const RESOURCE_TREE_TONE_HELP = Object\.freeze\(\{/);
  assert.match(panel, /const INSPECTOR_ACTION_GROUP_LABELS = Object\.freeze\(\{/);
  assert.match(panel, /RESOURCE_TREE_TONE_HELP\[normalizeTreeTone\(tone\)\] \|\| "浅灰色/);
  assert.match(panel, /INSPECTOR_ACTION_GROUP_LABELS\[section\] \|\| section \|\| "总览"/);
  assert.doesNotMatch(panel, /function resourceTreeGroupToneHelp\(tone\) \{\s*const map =/);
  assert.doesNotMatch(panel, /function inspectorActionGroupLabel\(section\) \{\s*const labels =/);
});
