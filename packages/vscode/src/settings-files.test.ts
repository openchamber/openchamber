import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreferencesFields,
  flattenPreferences,
  isPerSurfaceSettingsKey,
  instancePartOf,
  isDeviceSettingsKey,
  isProfileSettingsKey,
  parsePreferencesDocument,
  preferencesFilePathFor,
  seedPreferencesFrom,
  serializePreferencesDocument,
} from './settings-files';
import { SETTINGS_REGISTRY_FIELDS } from './settings-registry-gate';

const firstKeyWithScope = (scope: string): string => {
  const key = Object.keys(SETTINGS_REGISTRY_FIELDS).find((candidate) => SETTINGS_REGISTRY_FIELDS[candidate].scope === scope);
  assert.ok(key, `snapshot has a ${scope} key`);
  return key;
};
const deviceKey = firstKeyWithScope('device');

describe('parsePreferencesDocument', () => {
  test('rejects invalid JSON', () => {
    const result = parsePreferencesDocument('{ not json');
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.startsWith('invalid JSON'));
  });

  test('rejects a wrong version', () => {
    const result = parsePreferencesDocument(JSON.stringify({ version: 2, fields: {} }));
    assert.deepEqual(result, { ok: false, reason: 'not a version-1 preferences document' });
  });

  test('rejects non-object fields', () => {
    assert.equal(parsePreferencesDocument(JSON.stringify({ version: 1, fields: [] })).ok, false);
    assert.equal(parsePreferencesDocument(JSON.stringify({ version: 1, fields: 'x' })).ok, false);
    assert.equal(parsePreferencesDocument(JSON.stringify({ version: 1 })).ok, false);
  });

  test('rejects an entry without a value', () => {
    const result = parsePreferencesDocument(JSON.stringify({ version: 1, fields: { themeId: { updatedAt: 5 } } }));
    assert.deepEqual(result, { ok: false, reason: 'field "themeId" is not a { value, updatedAt } entry' });
  });

  test('accepts an empty document and defaults a missing stamp to 0', () => {
    assert.deepEqual(parsePreferencesDocument(JSON.stringify({ version: 1, fields: {} })), { ok: true, fields: {} });
    const result = parsePreferencesDocument(JSON.stringify({ version: 1, fields: { themeId: { value: 'nord' } } }));
    assert.deepEqual(result, { ok: true, fields: { themeId: { value: 'nord', updatedAt: 0 } } });
  });
});

describe('buildPreferencesFields', () => {
  const previous = {
    themeId: { value: 'nord', updatedAt: 100 },
    defaultModel: { value: 'zen/gpt-5', updatedAt: 100 },
    darkThemeId: { value: 'dracula', updatedAt: 100 },
  };

  test('keeps the stamp for unchanged values and restamps changed ones', () => {
    const next = buildPreferencesFields(previous, { themeId: 'nord', defaultModel: 'zen/gpt-5-mini', darkThemeId: 'dracula' }, 200);
    assert.deepEqual(next, {
      themeId: { value: 'nord', updatedAt: 100 },
      defaultModel: { value: 'zen/gpt-5-mini', updatedAt: 200 },
      darkThemeId: { value: 'dracula', updatedAt: 100 },
    });
  });

  test('compares structurally, so an equal object keeps its stamp', () => {
    const before = { themeId: { value: { a: 1, b: [1, 2] }, updatedAt: 7 } };
    const next = buildPreferencesFields(before, { themeId: { a: 1, b: [1, 2] } }, 9);
    assert.deepEqual(next, before);
  });

  test('drops profile keys the document no longer carries and ignores non-profile keys', () => {
    const next = buildPreferencesFields(previous, { themeId: 'nord', opencodeBinary: '/usr/bin/opencode', [deviceKey]: '#fff', unknownKey: 1 }, 200);
    assert.deepEqual(next, { themeId: { value: 'nord', updatedAt: 100 } });
  });

  test('skips undefined values', () => {
    assert.deepEqual(buildPreferencesFields({}, { themeId: undefined }, 1), {});
  });
});

describe('instancePartOf', () => {
  test('excludes profile keys and keeps instance and unknown legacy keys', () => {
    const document = { themeId: 'nord', defaultModel: 'x', opencodeBinary: '/bin/oc', legacyKey: true, dropped: undefined };
    assert.deepEqual(instancePartOf(document), { opencodeBinary: '/bin/oc', legacyKey: true });
  });
});

describe('scope helpers', () => {
  test('classify keys by the checked-in registry snapshot', () => {
    assert.equal(isProfileSettingsKey('themeId'), true);
    assert.equal(isProfileSettingsKey('opencodeBinary'), false);
    assert.equal(isDeviceSettingsKey(deviceKey), true);
    assert.equal(isDeviceSettingsKey('themeId'), false);
    assert.equal(isProfileSettingsKey('constructor'), false);
    assert.equal(isProfileSettingsKey('nope'), false);
  });

  test('preferences.json sits beside settings.json', () => {
    assert.equal(preferencesFilePathFor('/home/u/.config/openchamber/settings.json'), '/home/u/.config/openchamber/preferences.json');
  });
});

describe('round trip', () => {
  test('serialize then parse yields the same fields, and flatten yields the values', () => {
    const fields = seedPreferencesFrom({ themeId: 'nord', defaultModel: 'zen/gpt-5', opencodeBinary: '/bin/oc' }, 42);
    assert.deepEqual(fields, {
      themeId: { value: 'nord', updatedAt: 42 },
      defaultModel: { value: 'zen/gpt-5', updatedAt: 42 },
    });
    const text = serializePreferencesDocument(fields);
    assert.ok(text.startsWith('{\n  "version": 1,\n  "fields": {'));
    const parsed = parsePreferencesDocument(text);
    assert.deepEqual(parsed, { ok: true, fields });
    assert.deepEqual(flattenPreferences(fields), { themeId: 'nord', defaultModel: 'zen/gpt-5' });
  });
});

describe('per-surface keys', () => {
  const perSurfaceKey = Object.keys(SETTINGS_REGISTRY_FIELDS).find((key) => SETTINGS_REGISTRY_FIELDS[key].perSurface === true);
  const plainProfileKey = Object.keys(SETTINGS_REGISTRY_FIELDS).find(
    (key) => SETTINGS_REGISTRY_FIELDS[key].scope === 'profile' && SETTINGS_REGISTRY_FIELDS[key].perSurface !== true,
  );

  test('the snapshot names at least one per-surface profile key', () => {
    assert.ok(perSurfaceKey && isPerSurfaceSettingsKey(perSurfaceKey));
    assert.ok(plainProfileKey && !isPerSurfaceSettingsKey(plainProfileKey));
  });

  test('a surface write lands under the surface and leaves the base as it was', () => {
    assert.ok(perSurfaceKey && plainProfileKey);
    const previous = { [perSurfaceKey]: { value: 'base', updatedAt: 1 } };
    const next = buildPreferencesFields(previous, { [perSurfaceKey]: 'mine', [plainProfileKey]: 'shared' }, 5, {
      surface: 'vscode',
      changedKeys: [perSurfaceKey, plainProfileKey],
    });
    assert.deepEqual(next[perSurfaceKey], { value: 'base', updatedAt: 1, surfaces: { vscode: { value: 'mine', updatedAt: 5 } } });
    assert.deepEqual(next[plainProfileKey], { value: 'shared', updatedAt: 5 });
    assert.equal(flattenPreferences(next, 'vscode')[perSurfaceKey], 'mine');
    assert.equal(flattenPreferences(next, 'mobile')[perSurfaceKey], 'base');
    assert.equal(flattenPreferences(next)[perSurfaceKey], 'base');
  });

  test('a per-surface key the write did not change keeps its whole entry', () => {
    assert.ok(perSurfaceKey && plainProfileKey);
    const previous = { [perSurfaceKey]: { value: 'base', updatedAt: 1, surfaces: { mobile: { value: 'phone', updatedAt: 2 } } } };
    const next = buildPreferencesFields(previous, { [perSurfaceKey]: 'base', [plainProfileKey]: 'x' }, 9, {
      surface: 'vscode',
      changedKeys: [plainProfileKey],
    });
    assert.deepEqual(next[perSurfaceKey], previous[perSurfaceKey]);
  });

  test('a per-surface key first set from one surface has no base', () => {
    assert.ok(perSurfaceKey);
    const next = buildPreferencesFields({}, { [perSurfaceKey]: 'mine' }, 3, { surface: 'vscode', changedKeys: [perSurfaceKey] });
    assert.equal('value' in next[perSurfaceKey], false);
    assert.deepEqual(next[perSurfaceKey].surfaces, { vscode: { value: 'mine', updatedAt: 3 } });
    const parsed = parsePreferencesDocument(serializePreferencesDocument(next));
    assert.ok(parsed.ok);
    assert.equal(flattenPreferences(parsed.fields, 'mobile')[perSurfaceKey], undefined);
  });

  test('rejects an unknown surface in the file', () => {
    const result = parsePreferencesDocument(JSON.stringify({ version: 1, fields: { x: { surfaces: { toaster: { value: 1 } } } } }));
    assert.equal(result.ok, false);
  });
});
