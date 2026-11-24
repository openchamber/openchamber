import { z } from 'zod';
import type { PersistStorage, StateStorage, StorageValue } from 'zustand/middleware';
import { zonePlacementSchema } from '@/lib/workspace/zones';
import {
  CONTEXT_WINDOW_STATE_KEY,
  EMPTY_CONTEXT_WINDOW_RECORD,
  contextPanelsSchema,
  contextWindowRecordSchema,
  explicitPanelWindowPlacement,
  panelWindowPlacement,
  sizesSchema,
  withPanelEntry,
  type ContextWindowRecord,
} from './layoutState';

const LAYOUT_FIELDS = new Set<string>([
  'contextPanelByDirectory',
  'contextSurfaceZones',
  'contextZoneSizes',
  'contextZoneExpandedChatSizes',
]);

const storedStateSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  version: z.number().catch(0),
});

type StoredState = z.infer<typeof storedStateSchema>;

const isLayoutField = (key: string): boolean => LAYOUT_FIELDS.has(key);

const readStoredState = (raw: string | null | Promise<string | null>): StoredState | null => {
  if (raw === null || raw instanceof Promise) return null;
  try {
    const parsed = storedStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const recordOfStoredState = (raw: string | null | Promise<string | null>): ContextWindowRecord => {
  const stored = readStoredState(raw);
  return stored ? contextWindowRecordSchema.parse(stored.state) : EMPTY_CONTEXT_WINDOW_RECORD;
};

export const readContextWindowRecord = (storage: Pick<StateStorage, 'getItem'>): ContextWindowRecord => (
  recordOfStoredState(storage.getItem(CONTEXT_WINDOW_STATE_KEY))
);

export const writeContextWindowRecord = (storage: Pick<StateStorage, 'setItem'>, record: ContextWindowRecord): void => {
  void storage.setItem(CONTEXT_WINDOW_STATE_KEY, JSON.stringify({ state: record, version: 1 }));
};

type SharedFieldsListener = (fields: StoredState['state']) => void;

let sharedFieldsListener: SharedFieldsListener | null = null;

export const setSharedFieldsListener = (listener: SharedFieldsListener | null): void => {
  sharedFieldsListener = listener;
};

type ContextWindowStorageOptions = {
  ownerId: string;
  version: number;
  storage: () => StateStorage;
  layoutStorage: PersistStorage<ContextWindowRecord>;
  now?: () => number;
};

export const createContextWindowUIStorage = ({
  ownerId,
  version,
  storage,
  layoutStorage,
  now = Date.now,
}: ContextWindowStorageOptions): PersistStorage<unknown> => {
  let lastShared: StoredState['state'] = {};
  let lastLayout: StoredState['state'] = {};

  const readRecord = (): ContextWindowRecord => {
    const pending = layoutStorage.getItem(CONTEXT_WINDOW_STATE_KEY);
    if (pending && !(pending instanceof Promise)) return contextWindowRecordSchema.parse(pending.state);
    return readContextWindowRecord(storage());
  };

  const writeShared = (name: string, changed: StoredState['state'], persistedVersion: number): void => {
    const stored = readStoredState(storage().getItem(name));
    void storage().setItem(name, JSON.stringify({ state: { ...stored?.state, ...changed }, version: persistedVersion }));
    lastShared = { ...lastShared, ...changed };
    sharedFieldsListener?.(changed);
  };

  const writeLayout = (state: StoredState['state']): void => {
    const record = readRecord();
    const placementChanged = !Object.is(state.contextSurfaceZones, lastLayout.contextSurfaceZones);
    const sizesChanged = !Object.is(state.contextZoneSizes, lastLayout.contextZoneSizes);
    lastLayout = Object.fromEntries(Object.entries(state).filter(([key]) => isLayoutField(key)));
    const placement = explicitPanelWindowPlacement(zonePlacementSchema.parse(state.contextSurfaceZones), record.placement);
    const next: ContextWindowRecord = {
      ...record,
      placement: placementChanged ? placement : record.placement,
      sizes: sizesChanged ? sizesSchema.parse(state.contextZoneSizes) : record.sizes,
    };
    const entry = { byDirectory: contextPanelsSchema.parse(state.contextPanelByDirectory), placement, touchedAt: now() };
    void layoutStorage.setItem(CONTEXT_WINDOW_STATE_KEY, { state: withPanelEntry(next, ownerId, entry), version: 1 });
  };

  return {
    getItem: (name) => {
      const stored = readStoredState(storage().getItem(name));
      const record = readRecord();
      const shared = Object.fromEntries(Object.entries(stored?.state ?? {}).filter(([key]) => !isLayoutField(key)));
      const layout = {
        contextSurfaceZones: panelWindowPlacement(record.placement),
        contextZoneSizes: record.sizes,
        contextZoneExpandedChatSizes: {},
        contextPanelByDirectory: record.panels[ownerId]?.byDirectory ?? {},
      };
      lastShared = shared;
      lastLayout = layout;
      return { state: { ...shared, ...layout }, version: stored?.version ?? version };
    },
    setItem: (name, value: StorageValue<unknown>) => {
      const parsed = storedStateSchema.safeParse(value);
      if (!parsed.success) return;
      const { state, version: persistedVersion } = parsed.data;
      const changed = Object.entries(state).filter(([key, field]) => !isLayoutField(key) && !Object.is(field, lastShared[key]));
      if (changed.length > 0) writeShared(name, Object.fromEntries(changed), persistedVersion);
      if ([...LAYOUT_FIELDS].some((key) => !Object.is(state[key], lastLayout[key]))) writeLayout(state);
    },
    removeItem: () => {},
  };
};

export const panelWindowPlacedModes = (storage: Pick<StateStorage, 'getItem'>): ReadonlySet<string> => (
  new Set(Object.keys(readContextWindowRecord(storage).placement))
);
