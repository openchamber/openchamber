import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readConfigFile, writeConfig } from './shared.js';
import { diffArrayItems } from './jsonc-edits.js';

const dirs = [];
const fileWith = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-jsonc-array-'));
  dirs.push(dir);
  const file = path.join(dir, 'opencode.jsonc');
  fs.writeFileSync(file, text);
  return file;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

describe('diffArrayItems', () => {
  it('answers appends, removals, or null for anything else', () => {
    expect(diffArrayItems([1], [1, 2, 3], ['a'], equal)).toEqual([
      { type: 'insert-item', path: ['a', 1], value: 2 },
      { type: 'insert-item', path: ['a', 2], value: 3 },
    ]);
    expect(diffArrayItems([1, 2, 3, 4], [1, 3], ['a'], equal)).toEqual([
      { type: 'remove-item', path: ['a', 3] },
      { type: 'remove-item', path: ['a', 1] },
    ]);
    expect(diffArrayItems([1, 2], [2, 1], ['a'], equal)).toBeNull();
    expect(diffArrayItems([1, 2], [0, 1, 2], ['a'], equal)).toBeNull();
    expect(diffArrayItems([1, 2], [1, 3], ['a'], equal)).toBeNull();
  });
});

describe('writeConfig array edits', () => {
  const original = [
    '{',
    '  // rules for this repo',
    '  "policies": [',
    '    { "action": "integration.use", "resource": "skill:wild-*", "effect": "deny" }, // keep wild skills off',
    '    /* tools */ { "action": "tool.use", "resource": "shell:*", "effect": "deny" },',
    '  ],',
    '}',
    '',
  ].join('\n');
  const owned = { action: 'integration.use', resource: 'skill:alpha', effect: 'deny' };

  it('appends an item without touching the comments around the others', () => {
    const file = fileWith(original);
    const config = readConfigFile(file);
    config.policies.push(owned);
    writeConfig(config, file);

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('// rules for this repo');
    expect(text).toContain('// keep wild skills off');
    expect(text).toContain('/* tools */');
    expect(readConfigFile(file)).toEqual(config);
  });

  it('removes the appended item again and keeps the user comments', () => {
    const file = fileWith(original);
    const config = readConfigFile(file);
    config.policies.push(owned);
    writeConfig(config, file);
    config.policies.pop();
    writeConfig(config, file);

    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('gives back the original text after an append and removal in a list without a trailing comma', () => {
    const text = '{\n  "plugins": [\n    "a" // first\n  ]\n}\n';
    const file = fileWith(text);
    writeConfig({ plugins: ['a', 'b'] }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "plugins": [\n    "a", // first\n    "b"\n  ]\n}\n');
    writeConfig({ plugins: ['a'] }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('gives back the original text after a property is added and removed', () => {
    const text = '{\n  // settings\n  "model": "a/b"\n}\n';
    const file = fileWith(text);
    writeConfig({ model: 'a/b', policies: [{ action: 'integration.use', resource: 'skill:x', effect: 'deny' }] }, file);
    expect(readConfigFile(file).policies).toHaveLength(1);
    writeConfig({ model: 'a/b' }, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);

    const crlf = fileWith('{\r\n  "model": "a/b",\r\n  "theme": "dark"\r\n}\r\n');
    writeConfig({ model: 'a/b' }, crlf);
    expect(fs.readFileSync(crlf, 'utf8')).toBe('{\r\n  "model": "a/b"\r\n}\r\n');
  });

  it('removes an item from the middle of the list', () => {
    const file = fileWith(original);
    const config = readConfigFile(file);
    config.policies.splice(0, 1);
    writeConfig(config, file);

    expect(readConfigFile(file)).toEqual(config);
    expect(fs.readFileSync(file, 'utf8')).toContain('/* tools */');
  });

  it('appends to an empty or single-line list', () => {
    const empty = fileWith('{ "plugins": [] }');
    writeConfig({ plugins: ['a'] }, empty);
    expect(readConfigFile(empty)).toEqual({ plugins: ['a'] });

    const inline = fileWith('{ "plugins": ["a"] /* inline */ }');
    writeConfig({ plugins: ['a', 'b'] }, inline);
    expect(fs.readFileSync(inline, 'utf8')).toBe('{ "plugins": ["a", "b"] /* inline */ }');
    writeConfig({ plugins: ['a'] }, inline);
    expect(fs.readFileSync(inline, 'utf8')).toBe('{ "plugins": ["a"] /* inline */ }');
  });

  it('still replaces a reordered list whole', () => {
    const file = fileWith('{ "plugins": ["a", "b"] }');
    writeConfig({ plugins: ['b', 'a'] }, file);
    expect(readConfigFile(file)).toEqual({ plugins: ['b', 'a'] });
  });
});

describe('writeConfig array edits on other config lists', () => {
  const rule = (action, resource, effect) => ({ action, resource, effect });

  it('appends and removes a top-level permission rule without touching the others', () => {
    const text = [
      '{',
      '  "permissions": [',
      '    { "action": "shell", "resource": "git push *", "effect": "ask" }, // ask before pushing',
      '    { "action": "edit", "resource": "*", "effect": "allow" }',
      '  ]',
      '}',
      '',
    ].join('\n');
    const file = fileWith(text);
    const config = readConfigFile(file);
    config.permissions.push(rule('webfetch', '*', 'deny'));
    writeConfig(config, file);
    expect(fs.readFileSync(file, 'utf8')).toContain('// ask before pushing');
    expect(readConfigFile(file)).toEqual(config);

    config.permissions.pop();
    writeConfig(config, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('edits the rules nested under an agent and leaves the sibling agent alone', () => {
    const text = [
      '{',
      '  "agents": {',
      '    "build": {',
      '      // build rules',
      '      "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }]',
      '    },',
      '    "plan": { "permissions": [{ "action": "edit", "resource": "*", "effect": "deny" }] } // read-only',
      '  }',
      '}',
      '',
    ].join('\n');
    const file = fileWith(text);
    const config = readConfigFile(file);
    config.agents.build.permissions.push(rule('webfetch', '*', 'allow'));
    writeConfig(config, file);
    const added = fs.readFileSync(file, 'utf8');
    expect(added).toContain('// build rules');
    expect(added).toContain('// read-only');
    expect(readConfigFile(file)).toEqual(config);

    config.agents.build.permissions.pop();
    writeConfig(config, file);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('replaces a list whose items changed in place', () => {
    const file = fileWith('{\n  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }] // shell\n}\n');
    writeConfig({ permissions: [rule('shell', '*', 'deny')] }, file);
    expect(readConfigFile(file)).toEqual({ permissions: [rule('shell', '*', 'deny')] });
    expect(fs.readFileSync(file, 'utf8')).toContain('// shell');
  });
});
