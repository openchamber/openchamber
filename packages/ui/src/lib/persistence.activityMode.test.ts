import { expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { loadDesktopSettings, updateDesktopSettings } from './persistence';

test('stores a value read from a removed mode when another mode is chosen', async () => {
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
  const saved: Array<Partial<SettingsPayload>> = [];
  const settings: RuntimeAPIs['settings'] = {
    load: async () => ({ settings: { activityRenderMode: 'grouped', keepEarlierReplies: true, fontSize: 15 }, source: 'web' }),
    save: async (changes) => {
      saved.push(changes);
      return { ...changes };
    },
  };
  registerRuntimeAPIs(Object.assign(Object.create(null), { settings }));
  await loadDesktopSettings();

  await updateDesktopSettings({ activityRenderMode: 'summary', chatRenderMode: 'live', keepEarlierReplies: true, fontSize: 15 });
  expect(saved).toEqual([{ activityRenderMode: 'summary', chatRenderMode: 'live', keepEarlierReplies: true }]);
});
