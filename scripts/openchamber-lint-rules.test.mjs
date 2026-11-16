import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = ['no-module-mocks-in-tests', 'no-real-waits-in-tests', 'no-source-text-in-tests', 'no-comments', 'no-cross-runtime-imports', 'no-effects-in-components', 'no-raw-fetch', 'no-timers', 'no-wire-client-imports'];

const FILES = {
  'packages/ui/src/components/Panel.tsx': [
    "import { useEffect, useLayoutEffect } from 'react';",
    "import type { Session } from '@opencode/client';",
    "import { createWebAPIs } from '../../../web/src/api';",
    "import type { Bridge } from '@openchamber/electron/bridge';",
    '// plain remark',
    '/** A doc block. */',
    '// external: because it flickers',
    '// external: https://bugs.webkit.org/show_bug.cgi?id=1 Safari drops the event',
    '// external: #4575 upstream sends the part twice',
    '// SAFETY: checked above',
    '// oxlint-disable-next-line no-console -- startup banner',
    'export function Panel(session: Session, bridge: Bridge) {',
    '  useEffect(() => {}, []);',
    '  useLayoutEffect(() => {}, []);',
    '  setTimeout(() => {}, 0);',
    '  window.requestAnimationFrame(() => {});',
    "  void fetch('/api/x');",
    '  return [session, bridge, createWebAPIs];',
    '}',
  ],
  'packages/ui/src/hooks/useThing.ts': [
    "import { useEffect } from 'react';",
    'export function useThing() {',
    '  useEffect(() => {}, []);',
    '  setInterval(() => {}, 1000);',
    '}',
  ],
  'packages/ui/src/components/Evasive.tsx': [
    "import * as R from 'react';",
    "import { useEffect as effect } from 'react';",
    "export type Runtime = typeof import('../../../web/src/api/index');",
    "export type Client = import('@opencode/client').OpenCodeClient;",
    "export { OpenCode } from '@opencode/client';",
    '// SAFETY: the guard above',
    '// narrowed it already',
    'export function Evasive() {',
    '  // ! not a banner',
    '  effect(() => {}, []);',
    '  R.useLayoutEffect(() => {}, []);',
    '}',
  ],
  'packages/ui/src/lib/thing.test.ts': [
    "import { mock } from 'bun:test';",
    "import { readFileSync } from 'node:fs';",
    "mock.module('./thing', () => ({}));",
    "const source = readFileSync(new URL('./thing.ts', import.meta.url), 'utf8');",
    "const written = readFileSync('/tmp/out.json', 'utf8');",
    'await new Promise((resolve) => setTimeout(resolve, 0));',
    'export const seen = [source, written];',
  ],
  'packages/ui/src/lib/timing/frame.ts': ['export const nextFrame = (run: () => void) => requestAnimationFrame(run);'],
  'packages/ui/src/lib/opencode/client.ts': ["export type { Session } from '@opencode/client';"],
  'packages/ui/src/lib/runtime-fetch.ts': ['export const runtimeFetch = (route: string) => fetch(route);'],
  'packages/ui/src/components/Panel.test.tsx': [
    "import { createWebAPIs } from '../../../web/src/api';",
    '// arrange',
    'setTimeout(() => createWebAPIs, 0);',
    "void fetch('/x');",
  ],
  'packages/web/server/lib/thing.js': [
    '/** @param {string} name */',
    'export const greet = (name) => name;',
    '// retry later',
    'setTimeout(() => {}, 0);',
    "void fetch('https://example.com');",
  ],
  'scripts/tool.mjs': ['// a script comment', 'setTimeout(() => {}, 0);'],
  'packages/ui/src/lib/i18n/messages/panel.i18n.ts': ['// Shown under the panel title.', "export const panel = { title: 'Panel' };"],
};

let directory;
let findings;

before(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'oc-lint-rules-'));
  for (const [file, lines] of Object.entries(FILES)) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${lines.join('\n')}\n`);
  }
  const config = path.join(directory, 'lint.config.json');
  writeFileSync(config, JSON.stringify({
    categories: { correctness: 'off' },
    jsPlugins: [{ name: 'openchamber', specifier: path.join(REPO_ROOT, 'tools/oxlint/openchamber/index.ts') }],
    rules: Object.fromEntries(RULES.map((rule) => [`openchamber/${rule}`, 'error'])),
  }));
  const result = spawnSync('bunx', ['oxlint', '-c', config, '-f', 'json', 'packages', 'scripts'], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(REPO_ROOT, 'node_modules/.bin')}${path.delimiter}${process.env.PATH}` },
  });
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  findings = report.diagnostics.map((diagnostic) => ({
    file: diagnostic.filename.replaceAll('\\', '/'),
    rule: diagnostic.code.replace(/^openchamber\((.*)\)$/, '$1'),
    line: diagnostic.labels[0].span.line,
  }));
});

after(() => rmSync(directory, { recursive: true, force: true }));

const linesOf = (file, rule) => findings
  .filter((finding) => finding.file === file && finding.rule === rule)
  .map((finding) => finding.line)
  .sort((left, right) => left - right);

test('a product component takes no effect, timer, bare fetch, wire type or runtime import', () => {
  const panel = 'packages/ui/src/components/Panel.tsx';
  assert.deepEqual(linesOf(panel, 'no-wire-client-imports'), [2]);
  assert.deepEqual(linesOf(panel, 'no-cross-runtime-imports'), [3, 4]);
  assert.deepEqual(linesOf(panel, 'no-effects-in-components'), [13, 14]);
  assert.deepEqual(linesOf(panel, 'no-timers'), [15, 16]);
  assert.deepEqual(linesOf(panel, 'no-raw-fetch'), [17]);
});

test('a comment is allowed only as an external reference, a SAFETY note or a directive', () => {
  assert.deepEqual(linesOf('packages/ui/src/components/Panel.tsx', 'no-comments'), [5, 6, 7]);
});

test('a hook may hold an effect but not a timer', () => {
  const hook = 'packages/ui/src/hooks/useThing.ts';
  assert.deepEqual(linesOf(hook, 'no-effects-in-components'), []);
  assert.deepEqual(linesOf(hook, 'no-timers'), [4]);
});

test('the owning modules, tests, message catalogs and code outside shared UI are left alone', () => {
  const quiet = [
    'packages/ui/src/lib/timing/frame.ts',
    'packages/ui/src/lib/opencode/client.ts',
    'packages/ui/src/lib/runtime-fetch.ts',
    'scripts/tool.mjs',
    'packages/ui/src/lib/i18n/messages/panel.i18n.ts',
  ];
  assert.deepEqual(findings.filter((finding) => quiet.includes(finding.file)), []);
});

test('server code keeps JSDoc types, timers and fetch, and takes no other comment', () => {
  assert.deepEqual(
    findings.filter((finding) => finding.file === 'packages/web/server/lib/thing.js'),
    [{ file: 'packages/web/server/lib/thing.js', rule: 'no-comments', line: 3 }],
  );
});

test('aliases, inline type imports and re-exports do not get around a rule', () => {
  const evasive = 'packages/ui/src/components/Evasive.tsx';
  assert.deepEqual(linesOf(evasive, 'no-cross-runtime-imports'), [3]);
  assert.deepEqual(linesOf(evasive, 'no-wire-client-imports'), [4, 5]);
  assert.deepEqual(linesOf(evasive, 'no-effects-in-components'), [10, 11]);
});

test('an allowed note may run over several lines, and a bang is no directive', () => {
  assert.deepEqual(linesOf('packages/ui/src/components/Evasive.tsx', 'no-comments'), [9]);
});

test('a test takes no module mock, real wait or source file read as text', () => {
  const file = 'packages/ui/src/lib/thing.test.ts';
  assert.deepEqual(linesOf(file, 'no-module-mocks-in-tests'), [3]);
  assert.deepEqual(linesOf(file, 'no-source-text-in-tests'), [4]);
  assert.deepEqual(linesOf(file, 'no-real-waits-in-tests'), [6]);
  assert.deepEqual(linesOf('packages/ui/src/components/Panel.test.tsx', 'no-real-waits-in-tests'), [3]);
  assert.deepEqual(linesOf('packages/ui/src/lib/thing.test.ts', 'no-timers'), []);
});
