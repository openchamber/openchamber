import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import lintConfig from '../../../oxlint.config.ts';
import antiSlopConfig from '../../../oxlint.anti-slop.config.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('server TypeScript lint rejects unsafe syntax and undocumented suppression', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-lint-'));
  const file = path.join(root, 'packages/web/server/lib/example.ts');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...lintConfig,
      jsPlugins: lintConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    fs.writeFileSync(file, `
      export const value: any = 1;
      export const required = value!;
      // @ts-ignore
      export const ignored = value;
      // @ts-expect-error
      export const expected = value;
      export { value as other } from './other.ts';
      export type { Input } from './input';
      export const lazy = () => import('./lazy.ts');
      export type Imported = import('./types').Value;
    `);
    const run = () => spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
      '-c', config, '-f', 'json', file,
    ], { cwd: root, encoding: 'utf8' });
    const invalid = run();
    expect(invalid.status, invalid.stderr).not.toBe(0);
    const diagnostics = JSON.parse(invalid.stdout).diagnostics;
    expect(diagnostics.filter(({ code }) => code === 'typescript(no-explicit-any)')).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'typescript(no-non-null-assertion)')).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'typescript(ban-ts-comment)')).toHaveLength(2);
    expect(diagnostics.filter(({ code }) => code === 'openchamber(server-js-specifiers)')).toHaveLength(4);
    fs.writeFileSync(file, `
      // @ts-expect-error: Deliberately checks the invalid boundary contract.
      export const expected: number = 'invalid';
      // @ts-ignore: Upstream platform types omit this supported runtime property.
      export const ignored: number = 'invalid';
      export { value as other } from './other.js';
      export type { Input } from './input.js';
      export const lazy = () => import('./lazy.js');
      export type Imported = import('./types.js').Value;
    `);
    const documented = run();
    expect(documented.status, documented.stdout + documented.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('external input type guards are allowed while unparsed helpers and redundant typeof checks fail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-guard-lint-'));
  const file = path.join(root, 'packages/web/server/lib/example.ts');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...antiSlopConfig,
      jsPlugins: antiSlopConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    const run = () => spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
      '-c', config, '-f', 'json', file,
    ], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(file, `
      export interface Input { id: string }
      export function isInput(value: unknown): value is Input {
        return value !== null && typeof value === 'object' && 'id' in value && typeof value.id === 'string';
      }
    `);
    const guard = run();
    expect(guard.status, guard.stdout + guard.stderr).toBe(0);
    fs.appendFileSync(file, `
      export function unparsed(value: unknown): boolean { return typeof value === 'string'; }
      export function redundant(value: string): boolean { return typeof value === 'string'; }
    `);
    const invalid = run();
    expect(invalid.status).not.toBe(0);
    const diagnostics = JSON.parse(invalid.stdout).diagnostics;
    expect(diagnostics.filter(({ code }) => code === 'anti-slop(no-unknown-parameters)')).toHaveLength(1);
    expect(diagnostics.filter(({ code }) => code === 'anti-slop(no-runtime-typeof)')).toHaveLength(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only exported single-unknown nullable parsers in the shared server folder admit boundary checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-server-parser-lint-'));
  try {
    const config = path.join(root, 'oxlint.json');
    fs.writeFileSync(config, JSON.stringify({
      ...antiSlopConfig,
      jsPlugins: antiSlopConfig.jsPlugins.map((plugin) => ({ ...plugin, specifier: path.resolve(repoRoot, plugin.specifier) })),
    }));
    const run = (relative, source) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      const result = spawnSync(path.join(repoRoot, 'node_modules/.bin/oxlint'), [
        '-c', config, '-f', 'json', file,
      ], { cwd: root, encoding: 'utf8' });
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout).diagnostics.map(({ code }) => code);
    };
    const shared = 'packages/web/server/lib/shared/parser.ts';
    for (const declaration of [
      'export function parse(value: unknown): string | null',
      'export const parse = (value: unknown): string | null =>',
      'export const parse = function(value: unknown): string | null',
      'export default function(value: unknown): string | null',
    ]) {
      expect(run(shared, `${declaration} { return typeof value === 'string' ? value : null; }`)).toEqual([]);
    }
    for (const declaration of [
      'function parse(value: unknown): string | null',
      'export function parse(value: unknown): string',
      'export function parse(value: unknown): boolean',
      'export function parse(value: unknown)',
      'export function parse(value: unknown, other: string): string | null',
      'export function parse(...value: unknown[]): string | null',
      'export function parse(value: unknown = null): string | null',
      'export function parse(value: unknown): unknown | null',
      'export function parse(value: unknown): any | null',
    ]) {
      const codes = run(shared, `${declaration} { return typeof value === 'string' ? value : null; }`);
      expect(codes).toContain('anti-slop(no-runtime-typeof)');
      if (!declaration.includes('unknown[]')) expect(codes).toContain('anti-slop(no-unknown-parameters)');
    }
    expect(run(shared, `export function parse(value: string): string | null {
      return typeof value === 'string' ? value : null;
    }`)).toContain('anti-slop(no-runtime-typeof)');
    expect(run(shared, `export function parse(value: unknown): string | null {
      const nested = () => typeof value === 'string';
      return nested() ? '' : null;
    }`)).toContain('anti-slop(no-runtime-typeof)');
    for (const file of [
      'packages/web/server/lib/other/parser.ts',
      'packages/web/server/lib/shared-other/parser.ts',
      'packages/web/bin/parser.ts',
      'packages/ui/src/parser.ts',
    ]) {
      const codes = run(file, `export function parse(value: unknown): string | null {
        return typeof value === 'string' ? value : null;
      }`);
      expect(codes).toContain('anti-slop(no-unknown-parameters)');
      expect(codes).toContain('anti-slop(no-runtime-typeof)');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
