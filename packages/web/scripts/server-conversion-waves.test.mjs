import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { conversionFolders, conversionWaves } from './server-conversion-waves.mjs';

test('leaves precede importers, converted dependencies are ready, cycles stay explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-conversion-waves-'));
  try {
    for (const [file, contents] of [
      ['server/lib/leaf/value.js', 'export const value = 1;'],
      ['server/lib/leaf/value.test.js', "import '../blocked/value.js';"],
      ['server/lib/leaf/value.d.ts', 'export declare const value: number;'],
      ['server/lib/converted/value.ts', 'export const value = 2;'],
      ['server/lib/middle/value.js', "export { value } from '../leaf/value.js';"],
      ['server/lib/ready/value.js', "export { value } from '../converted/value.js';"],
      ['server/lib/blocked/value.js', "import '../cycle-a/value.js';"],
      ['server/lib/cycle-a/value.js', "import('../cycle-b/value.js');"],
      ['server/lib/cycle-b/value.js', "import '../cycle-a/value.js';"],
      ['bin/cli.js', "import '../server/lib/middle/value.js';"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    const folders = conversionFolders(root);
    const result = conversionWaves(folders);
    expect(result.waves.map((wave) => wave.map(({ folder }) => folder))).toEqual([
      ['server/lib/leaf', 'server/lib/ready'], ['server/lib/middle'], ['bin'],
    ]);
    expect(result.completed.map(({ folder }) => folder)).toEqual(['server/lib/converted']);
    expect(result.remaining.map((group) => group.map(({ folder }) => folder))).toEqual([
      ['server/lib/cycle-a', 'server/lib/cycle-b'], ['server/lib/blocked'],
    ]);
    expect(folders.find(({ folder }) => folder === 'server/lib/leaf')).toMatchObject({ js: 1, ts: 0, tests: 1, declarations: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
