import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { assertServerProgramBoundary } from './server-program-boundary.mjs';

const scripts = fileURLToPath(new URL('./', import.meta.url));
const require = createRequire(import.meta.url);
const compilerPackage = path.dirname(require.resolve('typescript/package.json'));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-boundary-')));
  roots.push(root);
  const web = path.join(root, 'packages/web');
  for (const folder of ['server', 'bin', 'scripts', 'node_modules', 'build']) {
    fs.mkdirSync(path.join(web, folder), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'packages/ui/src'), { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(web, 'tsconfig.server.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      rootDir: '.', outDir: 'build', noCheck: true, allowJs: true,
      declaration: true, sourceMap: true, types: [],
    },
    include: ['server/**/*', 'bin/**/*'],
  }));
  fs.writeFileSync(path.join(web, 'server/index.ts'), 'export const value: number = 1;');
  fs.writeFileSync(path.join(web, 'bin/cli.js'), 'export const value = 1;');
  fs.writeFileSync(path.join(web, 'build/previous-build.txt'), 'keep the last build');
  fs.writeFileSync(path.join(root, 'packages/ui/src/types.ts'), 'export interface Binding { id: string }');
  fs.symlinkSync(compilerPackage, path.join(web, 'node_modules/typescript'), 'junction');
  for (const name of ['server-program-boundary.mjs', 'check-server-types.mjs', 'build-server.mjs']) {
    fs.copyFileSync(path.join(scripts, name), path.join(web, 'scripts', name));
  }
  return { root, web };
}

test('accepts owned implementations and a dependency published through declarations', () => {
  const { root, web } = fixture();
  const shared = path.join(root, 'packages/shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"@fixture/shared","types":"index.d.ts"}');
  fs.writeFileSync(path.join(shared, 'index.d.ts'), 'export interface Binding { id: string }');
  fs.mkdirSync(path.join(web, 'node_modules/@fixture'));
  fs.symlinkSync(shared, path.join(web, 'node_modules/@fixture/shared'), 'junction');
  fs.writeFileSync(path.join(web, 'server/index.ts'), `
    import type { Binding } from '@fixture/shared';
    export const value: Binding = { id: 'owned' };
  `);
  expect(() => assertServerProgramBoundary(web)).not.toThrow();
});

test.each(['check-server-types.mjs', 'build-server.mjs'])('%s rejects a type-only workspace escape before emission', (script) => {
  const { root, web } = fixture();
  fs.writeFileSync(path.join(web, 'server/index.ts'), `
    import type { Binding } from '../../ui/src/types.js';
    export const value: Binding = { id: 'escape' };
  `);
  const result = spawnSync(process.execPath, [path.join(web, 'scripts', script)], { encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain('Server compiler sources escape packages/web');
  expect(result.stderr).toContain('Move server-owned contracts into packages/web/server');
  expect(result.stderr).toContain('import type');
  expect(fs.readFileSync(path.join(web, 'build/previous-build.txt'), 'utf8')).toBe('keep the last build');
  expect(fs.readdirSync(path.join(root, 'packages/ui/src'))).toEqual(['types.ts']);
});

test('follows declaration dependencies to external implementation sources', () => {
  const { web } = fixture();
  fs.writeFileSync(path.join(web, 'server/contract.d.ts'), "export type { Binding } from '../../ui/src/types.js';");
  fs.writeFileSync(path.join(web, 'server/index.ts'), `
    import type { Binding } from './contract.js';
    export const value: Binding = { id: 'transitive' };
  `);
  expect(() => assertServerProgramBoundary(web)).toThrow('packages/ui/src/types.ts');
});

test('checks JavaScript entries even when they are not roots of the strict TypeScript check', () => {
  const { root, web } = fixture();
  fs.writeFileSync(path.join(root, 'packages/ui/src/runtime.js'), 'export const value = 1;');
  fs.writeFileSync(path.join(web, 'bin/cli.js'), "export { value } from '../../ui/src/runtime.js';");
  expect(() => assertServerProgramBoundary(web)).toThrow('packages/ui/src/runtime.js');
});

test('rejects a workspace package that exposes raw TypeScript sources', () => {
  const { root, web } = fixture();
  const shared = path.join(root, 'packages/shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"@fixture/shared","type":"module","exports":"./index.ts"}');
  fs.writeFileSync(path.join(shared, 'index.ts'), 'export interface Binding { id: string }');
  fs.mkdirSync(path.join(web, 'node_modules/@fixture'));
  fs.symlinkSync(shared, path.join(web, 'node_modules/@fixture/shared'), 'junction');
  fs.writeFileSync(path.join(web, 'server/index.ts'), `
    import type { Binding } from '@fixture/shared';
    export const value: Binding = { id: 'workspace' };
  `);
  expect(() => assertServerProgramBoundary(web)).toThrow('packages/shared/index.ts');
});

test.skipIf(process.platform === 'win32')('checks real paths rather than trusting a symlink inside the web package', () => {
  const { root, web } = fixture();
  fs.symlinkSync(path.join(root, 'packages/ui/src/types.ts'), path.join(web, 'server/linked.ts'));
  expect(() => assertServerProgramBoundary(web)).toThrow('server/linked.ts');
});
