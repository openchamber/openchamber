#!/usr/bin/env node

/**
 * Reproduction script for issue #1906:
 * "Model picker dropdown does not scroll to or expand the currently selected model"
 *
 * This script performs static analysis and runtime logic checks to demonstrate
 * the three missing behaviors in ModelPickerList.tsx:
 *
 * 1. No scroll to selected model on open
 * 2. No expansion of collapsed provider section for selected model
 * 3. Selection store always starts at index 0, ignoring selectedModel
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../ModelPickerList.tsx');
const source = readFileSync(sourcePath, 'utf-8');
const lines = source.split('\n');

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${description}`);
    failed++;
  }
}

function assertSourceContains(text, description) {
  if (source.includes(text)) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${description} — expected to find "${text}" in source`);
    failed++;
  }
}

function assertSourceMissing(text, description) {
  if (!source.includes(text)) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${description} — found unexpected "${text}" in source`);
    failed++;
  }
}

console.log('\n🔍 Issue #1906 — Model picker dropdown scroll/expand reproduction');
console.log('   Source: packages/ui/src/components/model-picker/ModelPickerList.tsx');
console.log('   Lines: 831\n');

// =========================================================================
// FINDING 1: Selection store always starts at 0, ignores selectedModel
// =========================================================================
console.log('=== FINDING 1: Selection always starts at index 0 ===');

// createIndexSelectionStore starts value at 0
assertSourceContains(
  'let value = 0;',
  'createIndexSelectionStore initializes selection to index 0',
);

// All selectionStore.set() calls and whether they reference selectedModel
const setCalls = lines
  .map((l, i) => ({ lineNo: i + 1, text: l }))
  .filter(({ text }) => text.includes('selectionStore.set('));
console.log(`   Info: selectionStore.set() found at lines: ${setCalls.map(c => c.lineNo).join(', ')}`);

const setReferencesSelectedModel = setCalls.some(c => c.text.includes('selectedModel'));
assert(
  !setReferencesSelectedModel,
  'No selectionStore.set() call references selectedModel — all ignore which model is selected',
);

// The only automated set is resetting to 0 on search change
const setToZeroOnSearch = setCalls.find(c => c.text.includes('set(0)'));
assert(
  !!setToZeroOnSearch,
  `selectionStore is reset to 0 on search query change (line ${setToZeroOnSearch?.lineNo})`,
);

// There is NO code that finds the index of selectedModel and sets selectionStore to it
const hasFindSelectedIndex = source.includes('selectedModel') &&
  (source.includes('findIndex') || source.includes('findIndex(')) &&
  source.includes('selectionStore.set');
assert(
  !hasFindSelectedIndex,
  'No code finds the selected model index in flatModelList and sets selectionStore to it',
);

// Verify selectedModel only used for aria-selected (visual), not for selection
const selectedModelRefs = lines
  .map((l, i) => ({ lineNo: i + 1, text: l.trim() }))
  .filter(({ text }) => text.includes('selectedModel'));
console.log(`   Info: selectedModel references (${selectedModelRefs.length} total):`);
for (const ref of selectedModelRefs) {
  console.log(`     L${ref.lineNo}: ${ref.text}`);
}
// All references should be for aria-selected rendering only
const nonVisualRefs = selectedModelRefs.filter(
  ({ text }) =>
    !text.includes('aria-selected') &&
    !text.includes('isSelected') &&
    !text.includes('selectedModel?:') && // prop type definition (L339)
    !text.includes('selectedModel,') &&  // prop destructuring (L379)
    !text.includes('selectedModel={') && // prop passing in parent
    !text.includes('selectedModel?.providerID') && // isSelected comparison (L572)
    !text.includes('selectedModel.modelID') &&  // isSelected comparison (L572)
    !text.includes('!selectedModel')      // notSelected icon check (L766)
);
assert(
  nonVisualRefs.length === 0,
  `selectedModel is ONLY used for visual marking (isSelected, aria-selected) and prop passing — not for selection/scroll/expand`,
);
if (nonVisualRefs.length > 0) {
  for (const ref of nonVisualRefs) {
    console.log(`     Non-visual reference at L${ref.lineNo}: ${ref.text}`);
  }
}

// =========================================================================
// FINDING 2: No scroll-to-selected-model on open
// =========================================================================
console.log('\n=== FINDING 2: No scroll to selected model on open ===');

// scrollIntoView helper exists
assertSourceContains(
  'const scrollIntoView',
  'scrollIntoView helper function exists (line 292)',
);

// Find all scrollIntoView calls (excluding the function definition itself)
const scrollCalls = lines
  .map((l, i) => ({ lineNo: i + 1, text: l }))
  .filter(({ text }) => text.includes('scrollIntoView(') && !text.includes('const scrollIntoView'));
console.log(`   Info: scrollIntoView() calls at lines: ${scrollCalls.map(c => c.lineNo).join(', ')}`);

// All scrollIntoView calls should only be in moveSelection
// (Exclude line 295 which is the fallback `node.scrollIntoView(...)` inside the helper itself)
const onlyInMoveSelection = scrollCalls
  .filter(c => c.lineNo !== 295) // helper function body fallback
  .every(c => {
    const nearbyLines = lines.slice(Math.max(0, c.lineNo - 10), c.lineNo + 1);
    return nearbyLines.some(l => l.includes('const moveSelection'));
  });
assert(
  onlyInMoveSelection,
  'Every scrollIntoView call is only reachable from moveSelection (keyboard navigation)',
);

// No scrollIntoView in any useEffect
const effectScroll = lines
  .map((l, i) => ({ lineNo: i + 1, text: l }))
  .filter(({ text }) => text.includes('useEffect'))
  .some(({ lineNo }) => {
    const block = lines.slice(lineNo, lineNo + 15).join('\n');
    return block.includes('scrollIntoView');
  });
assert(
  !effectScroll,
  'No useEffect calls scrollIntoView — scrolling on mount/selectedModel change never happens',
);

// No scrollIntoView references selectedModel
const scrollRefsSelectedModel = scrollCalls.some(c => c.text.includes('selectedModel'));
assert(
  !scrollRefsSelectedModel,
  'No scrollIntoView call references selectedModel — never scrolls to the selected entry',
);

// =========================================================================
// FINDING 3: No auto-expansion of collapsed provider section for selected model
// =========================================================================
console.log('\n=== FINDING 3: No auto-expansion of selected model\'s provider section ===');

// toggleSection is available
assertSourceContains(
  'toggleSection',
  'toggleSection function is available from useModelPickerSectionsStore',
);

// But selectedModel never triggers toggleSection — check if any line
// references both selectedModel and toggleSection together
const hasToggleForSelectedModel = lines.some(l => l.includes('selectedModel') && l.includes('toggleSection'));
assert(
  !hasToggleForSelectedModel,
  'No code calls toggleSection based on selectedModel — collapsed provider sections stay collapsed',
);

// flatModelList excludes collapsed sections
assertSourceContains(
  "if (collapsedSections.has(`provider:${provider.id}`)) return;",
  'flatModelList skips provider sections that are collapsed (line 491)',
);

// This means: if selectedModel's provider section IS collapsed, the model
// will NOT appear in flatModelList, so selectionStore can never point to it,
// and no row is rendered for it to scroll to.
console.log('   ⚠️  Consequence: If selected model\'s provider section is collapsed,');
console.log('      the model entry is excluded from flatModelList entirely.');
console.log('      No row is rendered → no DOM node to scroll to → invisible selection.');

// =========================================================================
// SUMMARY
// =========================================================================
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════');

const summaryLines = [
  ['Bug 1', 'Selection store starts at index 0', true],
  ['Bug 1', 'No code sets selection to selectedModel\'s index', !setReferencesSelectedModel],
  ['Bug 2', 'scrollIntoView only called from keyboard nav', onlyInMoveSelection],
  ['Bug 2', 'No useEffect scrolls to selected model on mount', !effectScroll],
  ['Bug 3', 'No toggleSection called for selected model\'s provider', !hasToggleForSelectedModel],
  ['Bug 3', 'Collapsed provider sections excluded from flatModelList', true],
];

for (const [bug, desc, result] of summaryLines) {
  console.log(`  ${result ? '✅' : '❌'} ${bug}: ${desc}`);
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}`);

// All assertions check for the ABSENCE of the expected fix behavior.
// When they pass, the bug is confirmed (the expected scroll/expand/selection
// behavior is missing from the code).
const bugConfirmed = failed === 0;

if (bugConfirmed) {
  console.log(`\n❌ ISSUE #1906 IS REPRODUCIBLE — all ${passed} assertions confirm missing behaviors.\n`);
} else {
  console.log(`\n⚠️  ${failed} assertion(s) failed — partial reproduction.\n`);
}

process.exit(bugConfirmed ? 0 : 1);
