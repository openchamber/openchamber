// The persisted clamps of useUIStore (#2042): context-tab labels (120),
// custom fonts (100) and vim mappings (10,000) are stored by the zustand
// persist partialize, so a cut that splits a surrogate pair bakes a lone
// high surrogate into the saved UI state.

import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

const originalPersistOptions = useUIStore.persist.getOptions();

const encodeRoundTrip = (value: string) => new TextDecoder().decode(new TextEncoder().encode(value));

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, customUiFont: '', customMonoFont: '', fileEditorVimMappings: '' });
});

describe('useUIStore persisted clamps', () => {
  test('a context-tab label straddling 120 is stored pair-safe', () => {
    useUIStore.getState().openContextPanelTab('/repo', {
      mode: 'plugin:hello',
      label: `${'a'.repeat(119)}\u{1F600}tail`,
    });
    const tab = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0];
    expect(tab?.label).toBe('a'.repeat(119));
    expect(encodeRoundTrip(tab?.label ?? '')).not.toContain('\uFFFD');
    // ASCII over-limit labels keep their exact length; under-limit intact pairs pass through.
    useUIStore.getState().openContextPanelTab('/repo', { mode: 'plugin:ascii', label: 'b'.repeat(200) });
    const ascii = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.find((entry) => entry.mode === 'plugin:ascii');
    expect(ascii?.label).toHaveLength(120);
    useUIStore.getState().openContextPanelTab('/repo', { mode: 'plugin:short', label: 'hi \u{1F600}' });
    const short = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.find((entry) => entry.mode === 'plugin:short');
    expect(short?.label).toBe('hi \u{1F600}');
  });

  test('a persisted context tab whose label straddles 120 rehydrates pair-safe', async () => {
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({
        version: 20,
        state: {
          contextPanelByDirectory: {
            '/repo': {
              isOpen: true,
              expanded: false,
              widthByMode: {},
              touchedAt: 1,
              activeTabId: 'chat:session:ses_1',
              tabs: [{
                id: 'chat:session:ses_1', mode: 'chat', dedupeKey: 'session:ses_1',
                targetPath: null, targetDirectory: null,
                label: `${'a'.repeat(119)}\u{1F600}tail`, sessionTitleFallback: null,
                readOnly: false, stagedDiff: false, diffScope: null, touchedAt: 1,
              }],
            },
          },
        },
      }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });

    try {
      useUIStore.setState(useUIStore.getInitialState(), true);
      await useUIStore.persist.rehydrate();
      const tab = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0];
      expect(tab?.label).toBe('a'.repeat(119));
    } finally {
      useUIStore.persist.setOptions(originalPersistOptions);
    }
  });

  test('a context-tab label at the exact limit ending in a lone high surrogate is stored pair-safe', () => {
    useUIStore.getState().openContextPanelTab('/repo', {
      mode: 'plugin:lone-surrogate',
      label: `${'a'.repeat(119)}\uD83D`,
    });
    const tab = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.find((entry) => entry.mode === 'plugin:lone-surrogate');
    expect(tab?.label).toBe('a'.repeat(119));
    expect(encodeRoundTrip(tab?.label ?? '')).not.toContain('\uFFFD');
  });

  test('a persisted context tab whose label is at the exact limit ending in a lone high surrogate rehydrates pair-safe', async () => {
    useUIStore.persist.setOptions({ storage: {
      getItem: () => ({
        version: 20,
        state: {
          contextPanelByDirectory: {
            '/repo': {
              isOpen: true,
              expanded: false,
              widthByMode: {},
              touchedAt: 1,
              activeTabId: 'chat:session:ses_1',
              tabs: [{
                id: 'chat:session:ses_1', mode: 'chat', dedupeKey: 'session:ses_1',
                targetPath: null, targetDirectory: null,
                label: `${'a'.repeat(119)}\uD83D`, sessionTitleFallback: null,
                readOnly: false, stagedDiff: false, diffScope: null, touchedAt: 1,
              }],
            },
          },
        },
      }),
      setItem: () => undefined,
      removeItem: () => undefined,
    } });

    try {
      useUIStore.setState(useUIStore.getInitialState(), true);
      await useUIStore.persist.rehydrate();
      const tab = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs[0];
      expect(tab?.label).toBe('a'.repeat(119));
      expect(encodeRoundTrip(tab?.label ?? '')).not.toContain('\uFFFD');
    } finally {
      useUIStore.persist.setOptions(originalPersistOptions);
    }
  });

  test('custom font families straddling 100 are stored pair-safe', () => {
    useUIStore.getState().setCustomUiFont(`${'f'.repeat(99)}\u{1F600}tail`);
    expect(useUIStore.getState().customUiFont).toBe('f'.repeat(99));
    useUIStore.getState().setCustomMonoFont(`${'f'.repeat(99)}\u{1F600}tail`);
    expect(useUIStore.getState().customMonoFont).toBe('f'.repeat(99));
    useUIStore.getState().setCustomUiFont('f'.repeat(150));
    expect(useUIStore.getState().customUiFont).toHaveLength(100);
    useUIStore.getState().setCustomMonoFont('Mono \u{1F600}');
    expect(useUIStore.getState().customMonoFont).toBe('Mono \u{1F600}');
  });

  test('vim mappings straddling 10,000 are stored pair-safe', () => {
    useUIStore.getState().setFileEditorVimMappings(`${'v'.repeat(9_999)}\u{1F600}tail`);
    expect(useUIStore.getState().fileEditorVimMappings).toBe('v'.repeat(9_999));
    expect(encodeRoundTrip(useUIStore.getState().fileEditorVimMappings)).not.toContain('\uFFFD');
    useUIStore.getState().setFileEditorVimMappings('v'.repeat(20_000));
    expect(useUIStore.getState().fileEditorVimMappings).toHaveLength(10_000);
    useUIStore.getState().setFileEditorVimMappings(`map ${'v'.repeat(10)} \u{1F600}`);
    expect(useUIStore.getState().fileEditorVimMappings).toBe(`map ${'v'.repeat(10)} \u{1F600}`);
  });
});
