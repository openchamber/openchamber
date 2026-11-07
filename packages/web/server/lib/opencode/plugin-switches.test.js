import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createPluginSwitchStore, isPluginDenialOverridden, pluginPolicyResource, pluginSwitchState } from './plugin-switches.js';

let directory;
let filePath;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-plugin-switches-'));
  filePath = path.join(directory, 'plugin-switches.json');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('OpenChamber plugin switch store', () => {
  it('reads a missing file as nothing switched off', () => {
    const store = createPluginSwitchStore({ filePath });

    expect(store.read()).toEqual({ ok: true, resources: [] });
  });

  it('adds and removes a resource and writes it once', () => {
    const store = createPluginSwitchStore({ filePath });

    expect(store.set('plugin:leakshield', false)).toEqual({ changed: true });
    expect(store.set('plugin:leakshield', false)).toEqual({ changed: false });
    expect(store.read()).toEqual({ ok: true, resources: ['plugin:leakshield'] });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      disabled: ['plugin:leakshield'],
    });

    expect(store.set('plugin:leakshield', true)).toEqual({ changed: true });
    expect(store.set('plugin:leakshield', true)).toEqual({ changed: false });
    expect(store.read()).toEqual({ ok: true, resources: [] });
  });

  it('keeps every switched-off resource, sorted and deduplicated', () => {
    const store = createPluginSwitchStore({ filePath });
    store.set('plugin:zeta', false);
    store.set('plugin:alpha', false);
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, disabled: ['plugin:zeta', 'plugin:alpha', 'plugin:zeta'] }), 'utf8');

    expect(store.read()).toEqual({ ok: true, resources: ['plugin:zeta', 'plugin:alpha'] });
    store.set('plugin:beta', false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).disabled).toEqual(['plugin:alpha', 'plugin:beta', 'plugin:zeta']);
  });

  it('refuses to guess when the file cannot be read', () => {
    fs.writeFileSync(filePath, '{not json', 'utf8');
    const store = createPluginSwitchStore({ filePath });

    expect(store.read().ok).toBe(false);
    expect(() => store.set('plugin:leakshield', false)).toThrow();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{not json');
  });

  it('rejects a value that is not a plugin resource', () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, disabled: ['skill:leakshield'] }), 'utf8');
    const store = createPluginSwitchStore({ filePath });

    expect(store.read().ok).toBe(false);
    expect(() => store.set('leakshield', false)).toThrow('Invalid plugin resource');
  });

  it('lists the denials for the managed layer and throws instead of an empty list', () => {
    const store = createPluginSwitchStore({ filePath });
    store.set('plugin:leakshield', false);
    expect(store.denials()).toEqual([{ action: 'integration.use', resource: 'plugin:leakshield', effect: 'deny' }]);

    fs.writeFileSync(filePath, '{not json', 'utf8');
    expect(() => store.denials()).toThrow(filePath);
  });
});

describe('the resource of a package or Git spec', () => {
  // The expected values are what OpenCode's `PluginModule.load` compares: the
  // spec up to its last `@`.
  it.each([
    ['leakshield', 'plugin:leakshield'],
    ['leakshield@1.2.3', 'plugin:leakshield'],
    ['@acme/plugin', 'plugin:@acme/plugin'],
    ['@acme/plugin@1.2.3', 'plugin:@acme/plugin'],
    ['github:acme/plugin#main', 'plugin:github:acme/plugin#main'],
    ['git+https://github.com/acme/plugin.git#plugin@1.0.0', 'plugin:git+https://github.com/acme/plugin.git#plugin'],
    ['git+ssh://git@github.com/acme/plugin.git#plugin@1.0.0', 'plugin:git+ssh://git@github.com/acme/plugin.git#plugin'],
  ])('maps %s to %s', (spec, resource) => {
    expect(pluginPolicyResource(spec)).toBe(resource);
  });
});

describe('a config rule ahead of the switch denial', () => {
  const statement = (action, resource, effect) => ({ action, resource, effect });

  it('overrides the denial when the earliest match allows the plugin', () => {
    expect(isPluginDenialOverridden('plugin:leakshield', [{ policies: [statement('plugin.use', '*', 'allow')] }])).toBe(true);
    expect(isPluginDenialOverridden('plugin:leakshield', [{ policies: [statement('integration.use', 'plugin:leak*', 'allow')] }])).toBe(true);
  });

  it('follows the order OpenCode decides by: earliest config, last statement inside it', () => {
    const allow = statement('plugin.use', '*', 'allow');
    const deny = statement('plugin.use', 'leakshield', 'deny');

    expect(isPluginDenialOverridden('plugin:leakshield', [{ policies: [allow, deny] }])).toBe(false);
    expect(isPluginDenialOverridden('plugin:leakshield', [{ policies: [deny, allow] }])).toBe(true);
    expect(isPluginDenialOverridden('plugin:leakshield', [{ policies: [deny] }, { policies: [allow] }])).toBe(false);
    expect(isPluginDenialOverridden('plugin:leakshield', [{}, null, { policies: [allow] }])).toBe(true);
  });

  it('ignores statements about something else', () => {
    expect(isPluginDenialOverridden('plugin:leakshield', [{ policies: [
      statement('integration.use', '*', 'allow'),
      statement('skill.use', '*', 'allow'),
      statement('plugin.use', 'other', 'allow'),
    ] }])).toBe(false);
  });

  it('reports unavailable before overridden, and overridden before the stored state', () => {
    const ahead = [{ policies: [statement('plugin.use', '*', 'allow')] }];

    expect(pluginSwitchState({ ok: false, error: new Error('unreadable') }, 'plugin:leakshield', ahead)).toBe('unavailable');
    expect(pluginSwitchState({ ok: true, resources: ['plugin:leakshield'] }, 'plugin:leakshield', ahead)).toBe('overridden');
    expect(pluginSwitchState({ ok: true, resources: ['plugin:leakshield'] }, 'plugin:leakshield', [])).toBe('off');
    expect(pluginSwitchState({ ok: true, resources: [] }, 'plugin:leakshield', [])).toBe('on');
  });
});
