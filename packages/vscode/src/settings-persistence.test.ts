import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSettingsForPersistence } from './settings-persistence';

test('removes superseded settings while applying changes', () => {
  assert.deepEqual(
    mergeSettingsForPersistence(
      { wideChatLayoutEnabled: true, defaultAgent: 'build', themeId: 'old' },
      { chatMessageWidthMode: 'fluid', themeId: 'new' },
      new Set(['wideChatLayoutEnabled', 'defaultAgent']),
    ),
    { chatMessageWidthMode: 'fluid', themeId: 'new' },
  );
});
