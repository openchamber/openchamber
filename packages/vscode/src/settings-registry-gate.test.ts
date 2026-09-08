import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_REGISTRY_FIELDS, filterPersistableSettingsChanges, withoutSecretSettings, type SettingsRegistryGateFields } from './settings-registry-gate';

const fields: SettingsRegistryGateFields = {
  themeId: { scope: 'profile' },
  smallModelOverride: { scope: 'profile' },
  hasDesktopSettings: { scope: 'instance', computed: true },
  sidebarWidth: { scope: 'device', local: true },
  windowBounds: { scope: 'instance', owner: 'desktop-shell' },
  desktopUiPassword: { scope: 'instance', secret: true },
};

describe('withoutSecretSettings', () => {
  test('withholds secret keys and keeps everything else', () => {
    assert.deepEqual(withoutSecretSettings({ desktopUiPassword: 'pw', themeId: 'a' }, fields), { themeId: 'a' });
  });

  test('the real registry marks the UI password and tunnel tokens secret', () => {
    const stripped = withoutSecretSettings({
      desktopUiPassword: 'pw',
      managedRemoteTunnelToken: 't',
      managedRemoteTunnelPresetTokens: { a: 't' },
      themeId: 'a',
    }, SETTINGS_REGISTRY_FIELDS);
    assert.deepEqual(stripped, { themeId: 'a' });
  });
});

describe('filterPersistableSettingsChanges', () => {
  test('keeps stored shared fields and preserves their values as sent', () => {
    const result = filterPersistableSettingsChanges(
      { themeId: 'nord', smallModelOverride: '', unrelated: 1 },
      fields,
    );
    assert.deepEqual(result, { themeId: 'nord', smallModelOverride: '' });
  });

  test('drops keys the registry does not know', () => {
    assert.deepEqual(filterPersistableSettingsChanges({ gitProviderId: 'zen', gitModelId: 'x' }, fields), {});
  });

  test('drops computed, local, and desktop-shell owned keys', () => {
    const result = filterPersistableSettingsChanges(
      { hasDesktopSettings: true, sidebarWidth: 320, windowBounds: { x: 0 }, themeId: 'a' },
      fields,
    );
    assert.deepEqual(result, { themeId: 'a' });
  });

  test('ignores prototype keys that are not registry fields', () => {
    assert.deepEqual(filterPersistableSettingsChanges({ constructor: 'x', toString: 'y' }, fields), {});
  });

  test('the checked-in snapshot drops derived-at-read and desktop-shell keys but keeps profile settings', () => {
    const result = filterPersistableSettingsChanges({
      themeId: 'nord',
      smallModelUseDefault: false,
      smallModelOverride: 'zen/gpt-5-nano',
      gitProviderId: 'zen',
      gitModelId: 'gpt-5-nano',
    });
    assert.deepEqual(result, { themeId: 'nord', smallModelUseDefault: false, smallModelOverride: 'zen/gpt-5-nano' });

    const computedKeys = Object.entries(SETTINGS_REGISTRY_FIELDS).filter(([, field]) => field.computed).map(([key]) => key);
    const localKeys = Object.entries(SETTINGS_REGISTRY_FIELDS).filter(([, field]) => field.local).map(([key]) => key);
    const shellKeys = Object.entries(SETTINGS_REGISTRY_FIELDS).filter(([, field]) => field.owner === 'desktop-shell').map(([key]) => key);
    assert.ok(computedKeys.length > 0 && localKeys.length > 0 && shellKeys.length > 0, 'snapshot exercises every gate branch');
    const blocked = Object.fromEntries([...computedKeys, ...localKeys, ...shellKeys].map((key) => [key, 'value']));
    assert.deepEqual(filterPersistableSettingsChanges(blocked), {});
  });
});
