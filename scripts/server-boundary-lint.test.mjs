import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = fileURLToPath(new URL('../tools/oxlint/anti-slop/index.ts', import.meta.url));

test('server dictionary guards retain unknown fields without allowing unparsed helper contracts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-boundary-lint-'));
  try {
    const configPath = path.join(directory, 'lint.json');
    const sourcePath = path.join(directory, 'boundary.ts');
    const lint = async (source, allowInTypeGuards) => {
      await writeFile(configPath, JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'anti-slop', specifier: plugin }],
        rules: { 'anti-slop/no-unsafe-dictionary-type': ['error', { allowInTypeGuards }] },
      }));
      await writeFile(sourcePath, source);
      const result = spawnSync('bunx', ['oxlint', '--no-ignore', '-c', configPath, sourcePath], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      return result;
    };
    const guard = 'export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";';
    const allowed = await lint(guard, true);
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    for (const [source, option] of [
      [guard, false],
      ['export const passthrough = (value: Record<string, unknown>) => value;', true],
      ['export function read(): Record<string, unknown> { return {}; }', true],
      ['export const values: Record<string, unknown> = {};', true],
      ['export const isRecord = (value: unknown): value is Record<string, any> => true;', true],
      ['export const isRecord = (value: unknown): value is Record<string, object> => true;', true],
      ['export const isRecord = (value: unknown): value is Record<string, {}> => true;', true],
    ]) {
      const result = await lint(source, option);
      assert.notEqual(result.status, 0, source);
      assert.match(result.stdout + result.stderr, /no-unsafe-dictionary-type/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
