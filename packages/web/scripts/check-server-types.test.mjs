import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { batchByCommandLength, findPairedDeclarations, findServerTypeScript } from './check-server-types.mjs';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

test('the conversion gate rejects declaration twins in every server and CLI folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-pairs-'));
  try {
    for (const folder of ['server/lib/leaf', 'bin/lib']) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
      fs.writeFileSync(path.join(root, folder, 'value.ts'), 'export const value = 1;');
      fs.writeFileSync(path.join(root, folder, 'value.d.ts'), 'export declare const value: number;');
      fs.writeFileSync(path.join(root, folder, 'contract.d.ts'), 'export type Id = string;');
    }
    const files = findServerTypeScript(root);
    expect(files).toHaveLength(2);
    expect(findPairedDeclarations(files)).toEqual(files);
    const gated = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { checkServerTypes } from ${JSON.stringify(new URL('./check-server-types.mjs', import.meta.url).href)};
      process.exitCode = checkServerTypes(${JSON.stringify(root)});
    `], { encoding: 'utf8' });
    expect(gated.status).toBe(1);
    expect(gated.stderr).toContain('delete the paired .d.ts');
    fs.unlinkSync(path.join(root, 'server/lib/leaf/value.d.ts'));
    expect(findPairedDeclarations(files)).toEqual([path.join(root, 'bin/lib/value.ts')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict checking admits JS dependencies and rejects unsafe types, overrides and source extensions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-strict-'));
  try {
    fs.mkdirSync(path.join(root, 'server'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.symlinkSync(path.join(webRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(root, 'tsconfig.server-check.json'), JSON.stringify({
      extends: path.join(webRoot, 'tsconfig.server-check.json'),
      include: ['server/**/*.ts', 'bin/**/*.ts'],
    }));
    fs.writeFileSync(path.join(root, 'server/legacy.js'), 'export const legacy = { label: "legacy" };');
    fs.writeFileSync(path.join(root, 'server/typed.ts'), 'export const value = 1;');
    fs.writeFileSync(path.join(root, 'server/valid.ts'), `
      import { legacy } from './legacy.js';
      export const label: string = legacy.label;
      export const answer: number = 42;
    `);
    const run = () => spawnSync(process.execPath, [
      fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
      '-p', path.join(root, 'tsconfig.server-check.json'), '--pretty', 'false',
    ], { encoding: 'utf8' });
    const valid = run();
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    fs.writeFileSync(path.join(root, 'bin/invalid.ts'), `
      import { value } from '../server/typed.ts';
      export const index: string = ['value'][9];
      export const optional: { name?: string } = { name: undefined };
      export function implicit(value) { return value; }
      export const wrong: number = null;
      class Base { method() {} }
      export class Child extends Base { method() {} }
      export enum Unsupported { Value }
      export const imported = value;
    `);
    const invalid = run();
    expect(invalid.status).not.toBe(0);
    for (const code of ['TS5097', 'TS2322', 'TS2375', 'TS7006', 'TS4114', 'TS1294']) {
      expect(invalid.stdout).toContain(code);
    }
    expect(fs.readdirSync(path.join(root, 'bin'))).toEqual(['invalid.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('server lint receives every file in batches that fit a Windows command line', () => {
  const files = Array.from({ length: 900 }, (_, index) => `server/lib/some-feature-folder/some-module-name-${index}.ts`);
  const batches = batchByCommandLength(files);
  expect(batches.flat()).toEqual(files);
  expect(batches.length).toBeGreaterThan(1);
  for (const batch of batches) expect(batch.join(' ').length).toBeLessThan(32_000);
});

test('server lint checks a root other than this package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-lint-'));
  try {
    fs.mkdirSync(path.join(root, 'server'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'server/value.ts'), 'export const value = 1;\n');
    const linted = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { checkServerTypes } from ${JSON.stringify(new URL('./check-server-types.mjs', import.meta.url).href)};
      process.exitCode = checkServerTypes(${JSON.stringify(root)}, true);
    `], { encoding: 'utf8' });
    expect(linted.status, linted.stdout + linted.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
