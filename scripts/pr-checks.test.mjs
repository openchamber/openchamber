import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { evaluateRuntimeProof } = createRequire(import.meta.url)('../.github/scripts/pr-checks.cjs');

const body = (rows, known) => `## Affected surfaces\n<!-- not run is banned -->\n| Runtime | What you ran and saw |\n|---|---|\n${Object.entries(rows).map(([k,v])=>`| ${k} | ${v} |`).join('\n')}\n\n## Known problems\n\n${known}\n\n<!-- x -->\n`;
const f = (...names) => names.map((filename) => ({ filename, status: 'modified' }));
const run = (files, rows, known='None', draft=false) => evaluateRuntimeProof({ pr: { body: body(rows, known), draft }, files });

test('shared UI is proven once, a runtime\'s own code in that runtime', () => {
  assert.deepEqual(run(f('packages/ui/src/components/chat/X.tsx'), { Web: 'opened chat, saw it', 'VS Code': 'not run' }), { unproven: [], knownProblems: false });
  assert.deepEqual(run(f('packages/vscode/src/a.ts'), { Web: 'ok', 'VS Code': 'not run' }).unproven, ['VS Code']);
  assert.deepEqual(run(f('packages/vscode/src/a.ts'), { Web: 'ok', 'VS Code': '' }).unproven, ['VS Code']);
  assert.deepEqual(run(f('packages/vscode/src/a.ts'), { Web: 'ok' }).unproven, ['VS Code']);
  assert.deepEqual(run(f('packages/vscode/src/a.ts'), { 'VS Code': 'Opened the panel in VS Code 1.99 on macOS, sent a prompt, reply rendered' }).unproven, []);
  assert.deepEqual(run(f('packages/mobile/src/x.ts','packages/electron/main.mjs'), { 'Desktop (Electron)': "couldn't test", 'Capacitor mobile': 'No device' }).unproven, ['Desktop (Electron)','Capacitor mobile']);
  assert.deepEqual(run(f('packages/ui/src/apps/MobileHeader.tsx'), { 'Capacitor mobile': 'N/A' }).unproven, ['Capacitor mobile']);
  assert.deepEqual(run(f('packages/vscode/src/a.test.ts','packages/docs/x.mdx'), {}).unproven, []);
  assert.deepEqual(run(f('packages/vscode/src/a.ts'), {}, 'None', true).unproven, []);
});

test('wording cannot get around the run, and honest rows are not misread', () => {
  const electron = f('packages/electron/main.mjs');
  assert.deepEqual(run(electron, { 'Desktop (Electron)': 'Not yet tested' }).unproven, ['Desktop (Electron)']);
  assert.deepEqual(run(electron, { 'Desktop (Electron)': 'Same code as web, run there' }).unproven, ['Desktop (Electron)']);
  assert.deepEqual(run(electron, { 'Desktop (Electron)': 'Ran in Electron on macOS; not runtime-specific otherwise' }).unproven, []);
  assert.deepEqual(run(f('packages/ui/src/assets/icons/file-types/folder-mobile.svg'), {}).unproven, []);
  assert.deepEqual(run(f('packages/ui/src/hooks/useMiniChatKeyboardShortcuts.ts'), {}).unproven, ['Desktop (Electron)']);
  assert.deepEqual(evaluateRuntimeProof({ pr: { body: '', draft: false }, files: [{ filename: 'packages/electron/main.mjs', status: 'removed' }] }).unproven, ['Desktop (Electron)']);
  assert.deepEqual(evaluateRuntimeProof({ pr: { body: '', draft: false }, files: [{ filename: 'packages/ui/src/lib/x.ts', previous_filename: 'packages/vscode/src/x.ts', status: 'renamed' }] }).unproven, ['VS Code']);
  assert.deepEqual(evaluateRuntimeProof({ pr: { body: '', draft: false, created_at: '2026-11-10T00:00:00Z' }, files: electron }).unproven, []);
  assert.equal(run(f('packages/ui/src/x.ts'), {}, 'None\n\n- Reload loses the draft').knownProblems, true);
  assert.equal(run(f('packages/ui/src/x.ts'), {}, 'None except that reload loses drafts').knownProblems, true);
});

test('a listed known problem means the pull request is not ready', () => {
  assert.equal(run(f('packages/ui/src/x.ts'), {}, 'None identified.').knownProblems, false);
  assert.equal(run(f('packages/ui/src/x.ts'), {}, '- The card can reopen after eviction').knownProblems, true);
  assert.equal(evaluateRuntimeProof({ pr: { body: '## Risks\nstuff', draft: false }, files: f('packages/ui/src/x.ts') }).knownProblems, false);
});

test('a relay change is run through the relay from a desktop client and from a phone', () => {
  const relay = f('packages/web/server/lib/relay/tunnel-host.js');
  assert.deepEqual(run(relay, { 'Capacitor mobile': 'Paired a phone, sent a prompt' }).unproven, ['Relay']);
  assert.deepEqual(run(relay, { Relay: 'Paired the desktop app relay-only, sent a prompt, reply streamed' }).unproven, ['Relay']);
  assert.deepEqual(run(relay, { Relay: 'Relay-only pairing: desktop app and the iOS Simulator both sent a prompt and streamed the reply' }).unproven, []);
  assert.deepEqual(run(f('packages/web/server/lib/share-pages/relay-client.js'), {}).unproven, []);
});
