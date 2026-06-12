import { create } from 'zustand';
import { getSafeStorage } from './utils/safeStorage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LabelColorKey =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'gray';

export interface SessionLabel {
  id: string;
  color: LabelColorKey;
  name: string;
}

// ---------------------------------------------------------------------------
// Color → CSS variable mapping
// ---------------------------------------------------------------------------

export const LABEL_COLOR_CSS_MAP: Record<LabelColorKey, string> = {
  red: 'var(--status-error)',
  orange: 'var(--syntax-type)',
  yellow: 'var(--status-warning)',
  green: 'var(--status-success)',
  blue: 'var(--primary)',
  purple: 'var(--syntax-keyword)',
  pink: 'var(--syntax-number)',
  gray: 'var(--syntax-comment)',
};

// ---------------------------------------------------------------------------
// Default labels
// ---------------------------------------------------------------------------

const DEFAULT_LABELS: SessionLabel[] = [
  { id: 'lbl-red', color: 'red', name: 'Red' },
  { id: 'lbl-orange', color: 'orange', name: 'Orange' },
  { id: 'lbl-yellow', color: 'yellow', name: 'Yellow' },
  { id: 'lbl-green', color: 'green', name: 'Green' },
  { id: 'lbl-blue', color: 'blue', name: 'Blue' },
  { id: 'lbl-purple', color: 'purple', name: 'Purple' },
  { id: 'lbl-pink', color: 'pink', name: 'Pink' },
  { id: 'lbl-gray', color: 'gray', name: 'Gray' },
];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oc.session-labels';

interface PersistedState {
  labels: SessionLabel[];
  sessionLabelMap: Record<string, string>;
}

const readState = (storage: Storage): PersistedState => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { labels: DEFAULT_LABELS, sessionLabelMap: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { labels: DEFAULT_LABELS, sessionLabelMap: {} };
    }
    const obj = parsed as Record<string, unknown>;
    const labels = Array.isArray(obj.labels) ? (obj.labels as SessionLabel[]) : DEFAULT_LABELS;
    const sessionLabelMap =
      typeof obj.sessionLabelMap === 'object' && obj.sessionLabelMap !== null
        ? (obj.sessionLabelMap as Record<string, string>)
        : {};
    return { labels, sessionLabelMap };
  } catch {
    return { labels: DEFAULT_LABELS, sessionLabelMap: {} };
  }
};

const persistState = (storage: Storage, state: PersistedState): void => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SessionLabelsStore {
  labels: SessionLabel[];
  sessionLabelMap: Record<string, string>;
  activeFilterLabelIds: Set<string>;

  renameLabel: (labelId: string, name: string) => void;
  resetLabelName: (labelId: string) => void;
  assignLabel: (sessionId: string, labelId: string) => void;
  removeLabel: (sessionId: string) => void;
  toggleFilter: (labelId: string) => void;
  clearFilters: () => void;
}

const safeStorage = getSafeStorage();
const initial = readState(safeStorage);

export const useSessionLabelsStore = create<SessionLabelsStore>((set, get) => ({
  labels: initial.labels,
  sessionLabelMap: initial.sessionLabelMap,
  activeFilterLabelIds: new Set(),

  renameLabel: (labelId, name) => {
    const { labels, sessionLabelMap } = get();
    const next = labels.map((l) => (l.id === labelId ? { ...l, name } : l));
    set({ labels: next });
    persistState(safeStorage, { labels: next, sessionLabelMap });
  },

  resetLabelName: (labelId) => {
    const defaultLabel = DEFAULT_LABELS.find((l) => l.id === labelId);
    if (!defaultLabel) return;
    const { labels, sessionLabelMap } = get();
    const next = labels.map((l) => (l.id === labelId ? { ...l, name: defaultLabel.name } : l));
    set({ labels: next });
    persistState(safeStorage, { labels: next, sessionLabelMap });
  },

  assignLabel: (sessionId, labelId) => {
    const { labels, sessionLabelMap } = get();
    const next = { ...sessionLabelMap, [sessionId]: labelId };
    set({ sessionLabelMap: next });
    persistState(safeStorage, { labels, sessionLabelMap: next });
  },

  removeLabel: (sessionId) => {
    const { labels, sessionLabelMap } = get();
    const next = { ...sessionLabelMap };
    delete next[sessionId];
    set({ sessionLabelMap: next });
    persistState(safeStorage, { labels, sessionLabelMap: next });
  },

  toggleFilter: (labelId) => {
    const { activeFilterLabelIds } = get();
    const next = new Set(activeFilterLabelIds);
    if (next.has(labelId)) {
      next.delete(labelId);
    } else {
      next.add(labelId);
    }
    set({ activeFilterLabelIds: next });
  },

  clearFilters: () => {
    set({ activeFilterLabelIds: new Set() });
  },
}));
