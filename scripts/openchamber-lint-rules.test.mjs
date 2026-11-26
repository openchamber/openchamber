import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveBunExecutable } from './lib/bun-executable.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = ['gatekeeper-standard-library', 'no-app-imports-in-opencode', 'no-module-mocks-in-tests', 'no-real-waits-in-tests', 'no-source-text-in-tests', 'no-comments', 'no-cross-runtime-imports', 'no-effects-in-components', 'no-raw-fetch', 'no-timers', 'no-wire-client-imports', 'no-valueof-type-escape', 'origin-check-awaited'];

const FILES = {
  'packages/web/server/lib/type-escape.ts': [
    'Object.prototype.valueOf.call(input);',
    'Object["prototype"]["valueOf"].apply(input, []);',
    'Number.prototype.valueOf.call(input);',
    'input.valueOf();',
  ],
  'packages/web/server/lib/origin-guard.ts': [
    'export const guard = async (req: unknown, runtime: { isRequestOriginAllowed: (req: unknown) => Promise<boolean> }, isPasswordlessSocketOriginAllowed: (req: unknown) => Promise<boolean>) => {',
    '  if (!runtime.isRequestOriginAllowed(req)) return 403;',
    '  if (isPasswordlessSocketOriginAllowed(req) && req) return 200;',
    '  const verdict = runtime.isRequestOriginAllowed(req) ? 200 : 403;',
    '  if (!await runtime.isRequestOriginAllowed(req)) return 403;',
    '  if (req && await isPasswordlessSocketOriginAllowed(req)) return verdict;',
    '  const pending = runtime.isRequestOriginAllowed(req);',
    '  if (!pending) return 403;',
    '  const awaited = await runtime.isRequestOriginAllowed(req);',
    '  if (!awaited) return 403;',
    '  const later = isPasswordlessSocketOriginAllowed(req);',
    '  if (!await later) return 403;',
    '  return runtime.isRequestOriginAllowed(req).then((allowed) => (allowed ? 200 : 403));',
    '};',
  ],
  'packages/web/server/lib/spaces/gatekeeper-program.cjs': [
    "const fs = require('node:fs');",
    "const http = require('http');",
    "require('./helper.cjs');",
    "require('undici');",
    "import('node:net');",
    "import('./helper.cjs');",
    "require('node:not-a-module');",
    "require(moduleName);",
  ],
  'packages/web/server/lib/spaces/gatekeeper-program.test.js': ["require('vitest');"],
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
  'packages/ui/src/lib/source-paths.test.ts': [
    "import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';",
    "import path from 'node:path';",
    "import os from 'node:os';",
    "import { fileURLToPath } from 'node:url';",
    "const directory = path.dirname(fileURLToPath(import.meta.url));",
    "const target = new URL('./thing.ts', import.meta.url);",
    "readFileSync(target, 'utf8');",
    "readFileSync(path.join(directory, '../Panel.tsx'), 'utf8');",
    "readFileSync(path.resolve(directory, 'thing.js'), 'utf8');",
    "readFileSync('packages/web/server/thing.jsx', 'utf8');",
    "readFileSync(new URL('./thing.mjs', import.meta.url), 'utf8');",
    "readFileSync(fileURLToPath(new URL('./thing.cjs', import.meta.url)), 'utf8');",
    "readFileSync(path.join(process.cwd(), 'packages/ui/src/thing.ts'), 'utf8');",
    "readFileSync(`packages/ui/src/thing.ts`, 'utf8');",
  ],
  'packages/ui/src/lib/output-files.test.ts': [
    "import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';",
    "import path from 'node:path';",
    "import os from 'node:os';",
    "readFileSync(path.join(os.tmpdir(), 'src/output.ts'), 'utf8');",
    "const temporary = mkdtempSync(path.join(os.tmpdir(), 'test-'));",
    "readFileSync(path.join(temporary, 'packages/ui/src/output.js'), 'utf8');",
    "const output = new URL('./generated.ts', import.meta.url);",
    "writeFileSync(output, 'generated');",
    "readFileSync(new URL('./generated.ts', import.meta.url), 'utf8');",
    "writeFileSync('packages/ui/src/output.ts', 'generated');",
    "readFileSync('packages/ui/src/output.ts', 'utf8');",
    "readFileSync('/tmp/output.ts', 'utf8');",
    "readFileSync(path.join(unknownDirectory, 'source.ts'), 'utf8');",
    "readFileSync(getFixture('source.ts'), 'utf8');",
    "readFileSync(new URL(`./${entry}.js`, import.meta.url), 'utf8');",
    "readFileSync(new URL('./thing.test.ts', import.meta.url), 'utf8');",
    "readFileSync(new URL('../../../../node_modules/package/index.js', import.meta.url), 'utf8');",
    "let mutable = './thing.ts'; mutable = unknownDirectory;",
    "readFileSync(mutable, 'utf8');",
    "const cyclic = cyclic; readFileSync(cyclic, 'utf8');",
    "custom.readFileSync('data.json', () => import('./thing.ts'));",
    "custom.readFileSync('packages/ui/src/thing.ts', 'utf8');",
    "const join = (...parts) => parts.at(-1);",
    "readFileSync(join('packages/ui/src', 'thing.ts'), 'utf8');",
    "readFileSync(new URL('https://example.com/source.ts', import.meta.url), 'utf8');",
    "readFileSync(new URL('../../../../../../outside.ts', import.meta.url), 'utf8');",
    "async function check() { const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'test-'))); readFileSync(path.join(dir, 'output.ts'), 'utf8'); }",
    "import { fileURLToPath } from 'node:url';",
    "readFileSync(fileURLToPath('file:///tmp/output.ts'), 'utf8');",
    "import fs from 'node:fs';",
    "await fs.promises.writeFile('packages/ui/src/async-output.ts', 'generated');",
    "await fs.promises.readFile('packages/ui/src/async-output.ts', 'utf8');",
  ],
  'packages/sdk/scripts/contracts.test.ts': [
    "import { readFile } from 'node:fs/promises';",
    "const examples = new URL('../examples/', import.meta.url);",
    "await readFile(new URL('plugin/package.json', examples), 'utf8');",
    "await readFile(new URL('style.css', examples), 'utf8');",
    "await readFile(new URL('README.md', examples), 'utf8');",
    "await readFile(new URL('index.html', examples), 'utf8');",
    "expect(await readFile(new URL('plugin/index.js', examples), 'utf8')).not.toMatch(/^import/m);",
    "await readFile(new URL(`${entry}.js`, examples), 'utf8');",
    "runInNewContext(await readFile(new URL(`${name}/index.js`, examples), 'utf8'), {});",
    "import { runInNewContext } from 'node:vm';",
    "runInNewContext(await readFile(new URL('plugin/index.js', examples), 'utf8'), {});",
    "import { stripTypeScriptTypes } from 'node:module';",
    "stripTypeScriptTypes(await readFile(new URL('plugin/index.ts', examples), 'utf8'));",
  ],
  'scripts/review.test.mjs': [
    "import fs from 'node:fs';",
    "await fs.promises.readFile('packages/ui/src/thing.ts', 'utf8');",
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
  'packages/web/server/lib/opencode/feature.js': [
    "import { createSettingsRuntime } from '../settings/settings-runtime.js';",
    "import { createThemeRuntime } from '../appearance/theme-runtime.js';",
    "import { registerSettingsUtilityRoutes } from '@openchamber/web/server/lib/server-frame/core-routes.js';",
    "export const routes = () => import('../self-update/openchamber-routes.js');",
    "export * from '../snippets/snippets.js';",
    "import { buildRestartNotification } from '../notifications/restart-notification.js';",
    "import { readConfig } from './config-files.js';",
    'export const used = [createSettingsRuntime, createThemeRuntime, registerSettingsUtilityRoutes, buildRestartNotification, readConfig];',
  ],
  'packages/web/server/lib/opencode/routes.js': [
    "import { settingsSurfaceOf } from '../settings/settings-files.js';",
    "import { createSettingsRuntime } from '../settings/settings-runtime.js';",
    'export const used = [settingsSurfaceOf, createSettingsRuntime];',
  ],
  'packages/web/server/lib/opencode/feature.test.js': ["import { expandSnippets } from '../snippets/snippets.js';", 'export const used = expandSnippets;'],
  'packages/web/server/lib/settings/frame.js': ["import { registerSettingsUtilityRoutes } from '../server-frame/core-routes.js';", 'export const used = registerSettingsUtilityRoutes;'],
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
  const result = spawnSync(resolveBunExecutable(), ['x', 'oxlint', '-c', config, '-f', 'json', 'packages', 'scripts'], {
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

test('object valueOf cannot hide an unchecked field shape behind its return type', () => {
  assert.deepEqual(linesOf('packages/web/server/lib/type-escape.ts', 'no-valueof-type-escape'), [1, 2]);
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

test('source reads resolve literal paths, file URLs and immutable aliases for every code extension', () => {
  assert.deepEqual(linesOf('packages/ui/src/lib/source-paths.test.ts', 'no-source-text-in-tests'), [7, 8, 9, 10, 11, 12, 13, 14]);
});

test('temporary, written, external and unknown paths do not imply a product source read', () => {
  assert.deepEqual(linesOf('packages/ui/src/lib/output-files.test.ts', 'no-source-text-in-tests'), []);
});

test('non-code contracts, dynamic example execution and type stripping stay allowed, but inspecting published code structure is flagged', () => {
  assert.deepEqual(linesOf('packages/sdk/scripts/contracts.test.ts', 'no-source-text-in-tests'), [7]);
});

test('script tests also flag product reads through fs.promises', () => {
  assert.deepEqual(linesOf('scripts/review.test.mjs', 'no-source-text-in-tests'), [2]);
});

test('lib/opencode takes no import from the app folders beyond its listed edges', () => {
  assert.deepEqual(linesOf('packages/web/server/lib/opencode/feature.js', 'no-app-imports-in-opencode'), [1, 2, 3, 4, 5]);
  assert.deepEqual(linesOf('packages/web/server/lib/opencode/routes.js', 'no-app-imports-in-opencode'), [2]);
  assert.deepEqual(linesOf('packages/web/server/lib/opencode/feature.test.js', 'no-app-imports-in-opencode'), []);
  assert.deepEqual(linesOf('packages/web/server/lib/settings/frame.js', 'no-app-imports-in-opencode'), []);
});

test('an origin check decides a condition only after it is awaited', () => {
  assert.deepEqual(linesOf('packages/web/server/lib/origin-guard.ts', 'origin-check-awaited'), [2, 3, 4, 7]);
});

test('the standalone gatekeeper imports only the Node standard library', () => {
  assert.deepEqual(linesOf('packages/web/server/lib/spaces/gatekeeper-program.cjs', 'gatekeeper-standard-library'), [3, 4, 6, 7, 8]);
  assert.deepEqual(linesOf('packages/web/server/lib/spaces/gatekeeper-program.test.js', 'gatekeeper-standard-library'), []);
  assert.deepEqual(linesOf('packages/web/server/lib/opencode/feature.js', 'gatekeeper-standard-library'), []);
});
