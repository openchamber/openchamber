import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { findOversizedGrowth, findRatchetViolations, parseOxlintReport, parseRenames, withKnipSnapshot } from './check-changed.mjs';

const counts = (entries) => new Map(entries.map(([file, rule, count]) => [`${file}\0${rule}`, count]));
const testTempRoot = process.platform === 'win32' ? tmpdir() : '/tmp';

test('old findings may stay or shrink', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]])), []);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 1]])), []);
});

test('code moved into a new shared file is not new', () => {
  const base = counts([['a.js', 'anti-slop(no-runtime-typeof)', 2], ['b.js', 'anti-slop(no-runtime-typeof)', 2]]);
  const current = counts([['shared.js', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, current), []);
});

test('a rule that grows across the change is a violation, naming the files it grew in', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3], ['a.ts', 'anti-slop(no-unknown-returns)', 2]]);
  const current = counts([
    ['a.ts', 'anti-slop(no-runtime-typeof)', 1],
    ['a.ts', 'anti-slop(no-unknown-returns)', 2],
    ['new.ts', 'anti-slop(no-unknown-returns)', 1],
  ]);
  assert.deepEqual(findRatchetViolations(base, current), [
    { rule: 'anti-slop(no-unknown-returns)', base: 2, current: 3, files: ['new.ts'] },
  ]);
});

test('a report with no files to lint is no findings, not a broken gate', () => {
  assert.deepEqual(parseOxlintReport('No files found to lint. Please check your paths and ignore patterns.\n'), []);
  const empty = '{\n  "diagnostics": [],\n  "number_of_files": 0\n}\n';
  assert.deepEqual(parseOxlintReport(`No files found to lint.\n${empty}`), []);
  assert.deepEqual(parseOxlintReport(empty), []);
  assert.throws(() => parseOxlintReport(''), /oxlint produced no report/);
});

test('a renamed file is compared with its old path', () => {
  assert.deepEqual(
    [...parseRenames('R100\told/a.ts\tnew/a.ts\nR087\tb.js\tc.js\n')],
    [['new/a.ts', 'old/a.ts'], ['c.js', 'b.js']],
  );
});

test('an implementation moved behind a rewritten entry keeps its old baseline', () => {
  assert.deepEqual([...parseRenames('M099\tindex.js\nC099\tindex.js\truntime.js\n')], [['runtime.js', 'index.js']]);
  // Copying code while retaining its implementation cannot inherit that baseline.
  assert.deepEqual([...parseRenames('C100\tindex.js\tduplicate.js\n')], []);
  assert.deepEqual([...parseRenames('M\tindex.js\nC099\tindex.js\tduplicate.js\n')], []);
  assert.deepEqual([...parseRenames('M099\tindex.js\nC099\tindex.js\tone.js\nC099\tindex.js\ttwo.js\n')], []);
});

test('a file over the limit cannot be added or grow, and may shrink or stay', () => {
  const size = (file, baseLines, currentLines) => ({ file, baseLines, currentLines });
  const sizes = [
    size('packages/ui/src/new-big.ts', null, 801),
    size('packages/ui/src/new-small.ts', null, 800),
    size('packages/ui/src/grew.tsx', 3000, 3001),
    size('packages/ui/src/crossed.tsx', 790, 810),
    size('packages/ui/src/shrank.tsx', 3000, 2500),
    size('packages/ui/src/same.tsx', 3000, 3000),
  ];
  assert.deepEqual(findOversizedGrowth(sizes).map(({ file }) => file), [
    'packages/ui/src/new-big.ts', 'packages/ui/src/grew.tsx', 'packages/ui/src/crossed.tsx',
  ]);
});

test('message catalogs, declarations, tests and files outside packages have no size limit', () => {
  const grown = (file) => ({ file, baseLines: 4000, currentLines: 4100 });
  assert.deepEqual(findOversizedGrowth([
    grown('packages/ui/src/lib/i18n/messages/en.ts'),
    grown('packages/ui/src/lib/i18n/messages/spaces.i18n.ts'),
    grown('packages/web/server/index.d.ts'),
    grown('packages/ui/src/sync/sync.test.ts'),
    grown('packages/ui/src/sync/__tests__/helpers.ts'),
    grown('scripts/anti-slop.mjs'),
  ]), []);
});

test('an oversized server file may grow when it converts from JavaScript to TypeScript, and only then', () => {
  const converted = (file, basePath, baseLines) => ({ file, basePath, baseLines, currentLines: baseLines + 120 });
  assert.deepEqual(findOversizedGrowth([
    converted('packages/web/server/lib/git/service.ts', 'packages/web/server/lib/git/service.js', 7626),
    converted('packages/web/bin/lib/commands.ts', 'packages/web/bin/lib/commands.js', 900),
    converted('packages/web/server/lib/server-frame/core-routes.ts', 'packages/web/server/lib/opencode/core-routes.js', 1156),
  ]), []);
  assert.deepEqual(findOversizedGrowth([
    converted('packages/web/server/lib/git/routes.ts', 'packages/web/server/lib/git/routes.js', 750),
    converted('packages/web/server/lib/git/service.ts', 'packages/web/server/lib/git/service.ts', 7626),
    converted('packages/web/server/lib/git/moved.ts', 'packages/web/server/lib/git/service.js', 7626),
    converted('packages/ui/src/big.ts', 'packages/ui/src/big.js', 900),
  ]).map(({ file }) => file), [
    'packages/web/server/lib/git/routes.ts', 'packages/web/server/lib/git/service.ts',
    'packages/web/server/lib/git/moved.ts', 'packages/ui/src/big.ts',
  ]);
});

test('Knip keeps package exports and real findings identical beneath .local', () => {
  const temp = mkdtempSync(path.join(testTempRoot, 'oc-knip-test-'));
  const visible = path.join(temp, 'visible');
  const hidden = path.join(temp, '.local', 'repo');
  const put = (root, file, content) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const knip = (cwd) => {
    const result = spawnSync('bunx', ['knip@5.80.0', '--include', 'files,exports,nsExports,types,nsTypes,enumMembers,duplicates', '--reporter', 'json'], {
      cwd, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  try {
    for (const root of [visible, hidden]) {
      put(root, '.gitignore', '*.local\nnode_modules/\n/tmp/\n**/dist/\n**/build/\nbrowser-profiles/\n');
      put(root, 'package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: ['packages/*'] }));
      put(root, 'knip.json', JSON.stringify({ workspaces: {
        '.': { entry: ['main.js'], project: ['*.js'] },
        'packages/web': { entry: ['main.js'], project: ['**/*.js'] },
      } }));
      put(root, 'main.js', "import { used } from './util.js'; console.log(used);\n");
      put(root, 'util.js', 'export const used = 1;\n');
      put(root, 'packages/web/package.json', JSON.stringify({ name: '@fixture/web', type: 'module', exports: {
        './server/*': { 'openchamber-source': './server/*', default: './build/server/*' },
      } }));
      put(root, 'packages/web/main.js', "import { api } from './server/public.js'; console.log(api);\n");
      put(root, 'packages/web/server/public.js', 'export const api = 1;\nexport const publicApi = 2;\n');
      if (process.platform !== 'win32') symlinkSync('packages/web/server', path.join(root, 'linked-source'), 'dir');
      put(root, 'node_modules/dependency/marker', 'root dependency');
      put(root, 'packages/web/node_modules/dependency/marker', 'workspace dependency');
      for (const file of ['tmp/verify/artifact', 'packages/ui/dist/bundle.js', 'packages/web/build/server/public.js', 'browser-profiles/profile']) {
        put(root, file, 'ignored output');
      }
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      put(root, 'deleted.js', 'export const deleted = 1;\n');
      execFileSync('git', ['add', '--', 'util.js', 'deleted.js'], { cwd: root });
      rmSync(path.join(root, 'deleted.js'));
    }
    const clean = knip(visible);
    assert.equal(clean.status, 0, JSON.stringify(clean.report));
    // The fixture reproduces the upstream absolute-ignore bug without the fix.
    assert.equal(knip(hidden).status, 1);
    let snapshotPath;
    const analyze = (cwd) => {
      snapshotPath = cwd;
      if (process.platform !== 'win32') {
        assert.equal(lstatSync(path.join(cwd, 'linked-source')).isSymbolicLink(), true);
        assert.equal(readFileSync(path.join(cwd, 'linked-source/public.js'), 'utf8'), 'export const api = 1;\nexport const publicApi = 2;\n');
      }
      for (const dir of ['.git', 'tmp', 'packages/ui/dist', 'packages/web/build', 'browser-profiles']) {
        assert.equal(existsSync(path.join(cwd, dir)), false, `${dir} must not be copied`);
      }
      assert.equal(readFileSync(path.join(cwd, 'node_modules/dependency/marker'), 'utf8'), 'root dependency');
      assert.equal(readFileSync(path.join(cwd, 'packages/web/node_modules/dependency/marker'), 'utf8'), 'workspace dependency');
      return knip(cwd);
    };
    assert.deepEqual(withKnipSnapshot(hidden, analyze), clean);
    assert.equal(existsSync(snapshotPath), false);

    for (const root of [visible, hidden]) put(root, 'util.js', 'export const used = 1;\nexport const deliberatelyUnused = 2;\n');
    const dirty = knip(visible);
    assert.equal(dirty.status, 1);
    assert.match(JSON.stringify(dirty.report), /deliberatelyUnused/);
    assert.deepEqual(withKnipSnapshot(hidden, analyze), dirty);
    assert.equal(existsSync(snapshotPath), false);

    assert.throws(() => withKnipSnapshot(hidden, (cwd) => {
      snapshotPath = cwd;
      throw new Error('analysis failed');
    }), /analysis failed/);
    assert.equal(existsSync(snapshotPath), false);
    assert.equal(readFileSync(path.join(hidden, 'node_modules/dependency/marker'), 'utf8'), 'root dependency');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('Knip runs in place outside hidden paths without enumerating or copying sources', () => {
  const root = mkdtempSync(path.join(testTempRoot, 'oc-knip-in-place-'));
  try {
    // No Git repository: even attempting snapshot enumeration would fail.
    writeFileSync(path.join(root, 'source.js'), 'current source');
    assert.equal(withKnipSnapshot(root, (cwd) => {
      assert.equal(cwd, root);
      assert.equal(readFileSync(path.join(cwd, 'source.js'), 'utf8'), 'current source');
      return 17;
    }), 17);
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime sockets do not prevent a source snapshot', { skip: process.platform === 'win32' }, async () => {
  const temp = mkdtempSync(path.join(testTempRoot, 'oc-knip-socket-'));
  const root = path.join(temp, '.hidden');
  const server = createServer();
  try {
    mkdirSync(path.join(root, '.tmp'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    const socket = path.join(root, '.tmp', 'dev.sock');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    writeFileSync(path.join(root, 'source.js'), 'export const source = 1;\n');
    withKnipSnapshot(root, (cwd) => {
      assert.equal(existsSync(path.join(cwd, '.tmp', 'dev.sock')), false);
      assert.equal(readFileSync(path.join(cwd, 'source.js'), 'utf8'), 'export const source = 1;\n');
    });
    assert.equal(existsSync(socket), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});
