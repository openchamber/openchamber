import { describe, expect, test } from 'bun:test';
import { mobileScreenAwakeModeSchema } from '@/lib/mobileScreenAwake';
import { useUIStore } from './useUIStore';
import { LOCAL_DEVICE_KEYS, MIRRORED_KEYS, parseSettingsDocument } from '@/lib/settings/registry';

describe('device-local mobile screen-awake preference', () => {
  test('missing and malformed modes default to Off', () => {
    for (const value of [undefined, null, '', 'invalid', true, 3, {}, []]) {
      expect(mobileScreenAwakeModeSchema.parse(value)).toBe('off');
    }
    expect(useUIStore.getInitialState().mobileScreenAwakeMode).toBe('off');
  });

  test('all modes survive actual persisted-store hydration', async () => {
    const options = useUIStore.persist.getOptions();
    const original = useUIStore.getState();
    let saved: Parameters<NonNullable<typeof options.storage>['setItem']>[1] = { state: original, version: options.version };
    try {
      for (const mode of ['off', 'working', 'always'] as const) {
        useUIStore.persist.setOptions({ storage: { getItem: () => saved, setItem: (_name, value) => { saved = value; }, removeItem: () => undefined } });
        useUIStore.getState().setMobileScreenAwakeMode(mode);
        const persisted = saved;
        useUIStore.persist.setOptions({ storage: { getItem: () => persisted, setItem: () => undefined, removeItem: () => undefined } });
        useUIStore.getState().setMobileScreenAwakeMode('off');
        await useUIStore.persist.rehydrate();
        expect(useUIStore.getState().mobileScreenAwakeMode).toBe(mode);
      }
    } finally {
      useUIStore.persist.setOptions(options);
      useUIStore.setState(original, true);
    }
  });

  test('hydration rejects malformed values without dropping unrelated preferences', () => {
    const original = useUIStore.getState();
    const merge = useUIStore.persist.getOptions().merge;
    if (!merge) throw new Error('Missing persistence merge');
    const restored = merge({ mobileScreenAwakeMode: 'invalid', isSidebarOpen: false }, original);
    expect(restored.mobileScreenAwakeMode).toBe('off');
    expect(restored.isSidebarOpen).toBe(false);
    expect(restored.setMobileScreenAwakeMode).toBe(original.setMobileScreenAwakeMode);
  });

  test('selecting the current mode does not publish or persist a no-op', () => {
    const original = useUIStore.getState();
    let publications = 0;
    const unsubscribe = useUIStore.subscribe(() => { publications += 1; });
    useUIStore.getState().setMobileScreenAwakeMode(original.mobileScreenAwakeMode);
    unsubscribe();
    expect(useUIStore.getState()).toBe(original);
    expect(publications).toBe(0);
  });

  test('server settings cannot read, seed, mirror or overwrite the local-only mode', () => {
    expect(LOCAL_DEVICE_KEYS).toContain('mobileScreenAwakeMode');
    expect(MIRRORED_KEYS).not.toContain('mobileScreenAwakeMode');
    expect(parseSettingsDocument({ mobileScreenAwakeMode: 'always' })).toEqual({});
  });
});
