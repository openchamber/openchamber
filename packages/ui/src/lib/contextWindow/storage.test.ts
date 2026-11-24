import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { PersistStorage, StateStorage } from 'zustand/middleware';
import { contextWindowRecordSchema, type ContextWindowRecord } from './layoutState';
import { createContextWindowUIStorage, readContextWindowRecord, writeContextWindowRecord } from './storage';

const memoryStorage = (): StateStorage => {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
};

const recordStorage = (raw: StateStorage): PersistStorage<ContextWindowRecord> => ({
  getItem: () => {
    const record = readContextWindowRecord(raw);
    return { state: record, version: 1 };
  },
  setItem: (_name, value) => writeContextWindowRecord(raw, contextWindowRecordSchema.parse(value.state)),
  removeItem: () => {},
});

const uiStoreSchema = z.object({ state: z.record(z.string(), z.unknown()), version: z.number() });

const readUiStore = (raw: StateStorage) => uiStoreSchema.parse(JSON.parse(String(raw.getItem('ui-store'))));

const panel = (tabId: string) => ({
  isOpen: true,
  tabs: [{ id: tabId, mode: 'git', targetPath: null, dedupeKey: tabId, label: null, touchedAt: 1 }],
  activeTabId: tabId,
});

const windowStorage = (raw: StateStorage, ownerId: string) => createContextWindowUIStorage({
  ownerId,
  version: 30,
  storage: () => raw,
  layoutStorage: recordStorage(raw),
  now: () => 10,
});

const hydrate = (storage: PersistStorage<unknown>) => uiStoreSchema.parse(storage.getItem('ui-store'));

const setup = () => {
  const raw = memoryStorage();
  raw.setItem('ui-store', JSON.stringify({
    version: 30,
    state: { theme: 'dark', fontSize: 14, contextSurfaceZones: { git: 'left' }, contextZoneSizes: { right: 500 }, contextPanelByDirectory: {} },
  }));
  writeContextWindowRecord(raw, contextWindowRecordSchema.parse({
    placement: { git: 'right' },
    sizes: { left: 420 },
    panels: { 'owner-0001': { byDirectory: { '/panel': panel('a') }, touchedAt: 5 } },
  }));
  return raw;
};

describe('panel window ui-store persistence', () => {
  test('reads the shared preferences with its own layout and tabs over them', () => {
    const hydrated = hydrate(windowStorage(setup(), 'owner-0001'));

    expect(hydrated.state.theme).toBe('dark');
    expect(hydrated.state.contextZoneSizes).toEqual({ left: 420 });
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(hydrated.state.contextPanelByDirectory))).toEqual(['/panel']);
    const placement = z.record(z.string(), z.string()).parse(hydrated.state.contextSurfaceZones);
    expect(placement.git).toBeUndefined();
    expect(placement.file).toBe('bottom');
  });

  test('writes back only what it changed, over what another window saved since', () => {
    const raw = setup();
    const storage = windowStorage(raw, 'owner-0001');
    const hydrated = hydrate(storage);
    const stored = readUiStore(raw);
    raw.setItem('ui-store', JSON.stringify({ ...stored, state: { ...stored.state, theme: 'light' } }));

    storage.setItem('ui-store', { version: 30, state: { ...hydrated.state, fontSize: 16 } });

    const after = readUiStore(raw);
    expect(after.state.fontSize).toBe(16);
    expect(after.state.theme).toBe('light');
    expect(after.state.contextSurfaceZones).toEqual({ git: 'left' });
    expect(after.state.contextZoneSizes).toEqual({ right: 500 });
  });

  test('keeps its zone moves and tabs out of ui-store', () => {
    const raw = setup();
    const storage = windowStorage(raw, 'owner-0001');
    const hydrated = hydrate(storage);
    const before = raw.getItem('ui-store');

    storage.setItem('ui-store', {
      version: 30,
      state: { ...hydrated.state, contextSurfaceZones: { git: 'left', file: 'bottom' }, contextPanelByDirectory: { '/panel': panel('b') } },
    });

    expect(raw.getItem('ui-store')).toBe(before);
    const record = readContextWindowRecord(raw);
    expect(record.placement.git).toBe('left');
    expect(record.placement.file).toBe('bottom');
    expect(record.placement.diff).toBe('right');
    // The Git surface keeps one tab per directory, whatever id it was stored under.
    expect(record.panels['owner-0001']?.byDirectory['/panel']?.tabs.map((tab) => tab.id)).toEqual(['git']);
  });

  test('a tab change in one panel window keeps the layout another one saved', () => {
    const raw = setup();
    const first = windowStorage(raw, 'owner-0001');
    const second = windowStorage(raw, 'owner-0002');
    const firstState = hydrate(first).state;
    const secondState = hydrate(second).state;

    first.setItem('ui-store', { version: 30, state: { ...firstState, contextSurfaceZones: { git: 'left' }, contextZoneSizes: { left: 500 } } });
    second.setItem('ui-store', { version: 30, state: { ...secondState, contextPanelByDirectory: { '/other': panel('c') } } });

    const record = readContextWindowRecord(raw);
    expect(record.placement.git).toBe('left');
    expect(record.sizes).toEqual({ left: 500 });
    expect(Object.keys(record.panels).sort()).toEqual(['owner-0001', 'owner-0002']);
  });
});
