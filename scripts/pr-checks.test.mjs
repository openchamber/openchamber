import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { evaluateRuntimeProof, evaluateVisualEvidence, linkedIssueNumbers } = createRequire(import.meta.url)('../.github/scripts/pr-checks.cjs');

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

test('text GitHub hides inside an HTML comment never counts as the author\'s answer', () => {
  const electron = f('packages/electron/main.mjs');
  const evaluate = (text) => evaluateRuntimeProof({ pr: { body: text, draft: false }, files: electron });
  const row = '| Desktop (Electron) | Ran in Electron on macOS and saw the window open |';
  assert.deepEqual(evaluate(`## Affected surfaces\n${row}\n`).unproven, []);
  // An unclosed comment hides everything after it.
  assert.deepEqual(evaluate(`## Affected surfaces\n<!-- \n${row}\n`).unproven, ['Desktop (Electron)']);
  assert.deepEqual(evaluate(`## Affected surfaces\n<!-- a --> <!-- \n${row}\n`).unproven, ['Desktop (Electron)']);
  assert.equal(run(f('packages/ui/src/x.ts'), {}, '<!-- - The card can reopen after eviction -->\nNone').knownProblems, false);
});

test('a literal comment marker in visible text does not hide what follows', () => {
  const electron = f('packages/electron/main.mjs');
  const evaluate = (text) => evaluateRuntimeProof({ pr: { body: text, draft: false }, files: electron });
  const row = '| Desktop (Electron) | Ran in Electron on macOS and saw the window open |';
  assert.deepEqual(evaluate(`## Affected surfaces\nThe parser now skips \`<!--\` markers.\n${row}\n`).unproven, []);
  assert.deepEqual(evaluate(`## Affected surfaces\n\`\` a \`<!--\` b \`\`\n${row}\n`).unproven, []);
  assert.deepEqual(evaluate(`## Affected surfaces\n\`\`\`html\n<!-- unclosed\n\`\`\`\n${row}\n`).unproven, []);
  assert.deepEqual(evaluate(`## Affected surfaces\n~~~\n<!--\n~~~\n${row}\n`).unproven, []);
  // Removing the inner comment leaves `<!` and `--` that GitHub shows as text.
  assert.deepEqual(evaluate(`## Affected surfaces\n<!<!-- x -->-- \n${row}\n`).unproven, []);
  // A backtick that never closes is plain text, so the comment after it is real.
  assert.deepEqual(evaluate(`## Affected surfaces\nit\`s <!-- x --> ok\n${row}\n`).unproven, []);
  assert.deepEqual(evaluate(`## Affected surfaces\nit\`s\n<!-- \n${row}\n`).unproven, ['Desktop (Electron)']);
  // A line-start comment ends the paragraph, so a backtick inside it closes no span.
  assert.deepEqual(evaluate(`## Affected surfaces\nit\`s\n<!-- see \`x\n${row}\n-->\n`).unproven, ['Desktop (Electron)']);
  // An unclosed marker mid-sentence, in a quoted fence or in indented code is text.
  assert.deepEqual(evaluate(`## Affected surfaces\nWrite <!-- to start one.\n${row}\n`).unproven, []);
  assert.deepEqual(evaluate(`## Affected surfaces\n> ~~~html\n> <!-- unclosed\n> ~~~\n\n${row}\n`).unproven, []);
  assert.deepEqual(evaluate(`## Affected surfaces\n\n    <!-- unclosed\n\n${row}\n`).unproven, []);
  assert.equal(run(f('packages/ui/src/x.ts'), {}, '`<!--` example\n\n- The card can reopen after eviction').knownProblems, true);
  assert.equal(run(f('packages/ui/src/x.ts'), {}, '```\n<!--\n```\n- The card can reopen after eviction').knownProblems, true);
});

test('a screenshot inside an HTML comment is not a screenshot', () => {
  const ui = f('packages/ui/src/components/chat/X.tsx');
  const image = '![chat](https://github.com/user-attachments/assets/abc)';
  const missing = (body) => evaluateVisualEvidence({ pr: { body, draft: false }, files: ui }).missingScreenshots;
  assert.equal(missing(`## Screenshots\n${image}\n`), false);
  assert.equal(missing(`## Screenshots\n<!-- ${image} -->\n`), true);
  assert.equal(missing(`## Screenshots\n<!-- drop images here\n${image}\n`), true);
  // Removing a comment never makes an image out of the text around it.
  assert.equal(missing('## Screenshots\n!<!-- note -->[before](https://example.org/image.png)\n'), true);
});

test('a Part of link inside an HTML comment links nothing', async () => {
  const github = {
    graphql: async () => ({
      repository: { pullRequest: { closingIssuesReferences: { nodes: [
        { number: 5, repository: { nameWithOwner: 'openchamber/openchamber' } },
        { number: 6, repository: { nameWithOwner: 'someone/else' } },
      ] } } },
    }),
  };
  const linked = (body) => linkedIssueNumbers({ github, owner: 'openchamber', repo: 'openchamber', pr: { number: 1, body } });
  assert.deepEqual(await linked('Part of #7\n<!-- Part of #8 -->\n<!-- e.g. Part of #9'), [5, 7]);
  assert.deepEqual(await linked('Part of https://github.com/openchamber/openchamber/issues/10'), [5, 10]);
  assert.deepEqual(await linked('Part of #12<!-- note -->3'), [5, 12]);
});
