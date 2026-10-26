import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';

const packageRoot = path.resolve(__dirname, '..');

const readJson = (relativePath: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), 'utf8'));

const placeholders = (value: string): string[] => (value.match(/\{\d+\}/g) ?? []).sort();

const localeFiles = (directory: string, prefix: string, suffix: string): string[] =>
  fs
    .readdirSync(path.join(packageRoot, directory))
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name !== `${prefix}${suffix}`)
    .map((name) => path.join(directory, name));

describe('extension localization bundles', () => {
  test('every runtime string bundle covers the English keys with matching placeholders', () => {
    const english = readJson('l10n/bundle.l10n.json');
    for (const file of localeFiles('l10n', 'bundle.l10n', '.json')) {
      const translated = readJson(file);
      for (const [key, source] of Object.entries(english)) {
        assert.ok(Object.hasOwn(translated, key), `${file} is missing the key ${JSON.stringify(key)}`);
        assert.deepEqual(
          placeholders(translated[key]),
          placeholders(source),
          `${file} changes the placeholders of ${JSON.stringify(key)}`
        );
      }
    }
  });

  test('every manifest bundle covers the English keys', () => {
    const english = readJson('package.nls.json');
    for (const file of localeFiles('.', 'package.nls', '.json')) {
      const translated = readJson(file);
      for (const key of Object.keys(english)) {
        assert.ok(Object.hasOwn(translated, key), `${file} is missing the key ${key}`);
      }
    }
  });
});
