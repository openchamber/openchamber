import { create } from 'zustand';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';
import { getSafeStorage } from './utils/safeStorage';

export type Instance = {
  id: string;
  label: string;
  origin: string;
  apiBaseUrl: string;
  createdAt: number;
  lastUsedAt: number | null;
};

type AddInstanceInput = {
  apiBaseUrl: string;
  label?: string;
};

type UpdateInstancePatch = Partial<Pick<Instance, 'label' | 'apiBaseUrl' | 'origin' | 'lastUsedAt'>>;

type InstancesStore = {
  instances: Instance[];
  currentInstanceId: string | null;
  defaultInstanceId: string | null;
  hydrated: boolean;
  addInstance: (input: AddInstanceInput) => string;
  updateInstance: (id: string, patch: UpdateInstancePatch) => void;
  removeInstance: (id: string) => void;
  setCurrentInstance: (id: string | null) => void;
  setDefaultInstance: (id: string | null) => void;
  touchInstance: (id: string) => void;
  markHydrated: () => void;
};

const STORAGE_KEY = 'instances-store';

const createInstanceId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `inst_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
};

const normalizeApiBaseUrl = (value: string): { apiBaseUrl: string; origin: string } => {
  const input = value.trim();
  const parsed = new URL(input);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const path = pathname.endsWith('/api') ? pathname : '/api';
  const apiBaseUrl = `${parsed.origin}${path}`;
  return { apiBaseUrl, origin: parsed.origin };
};

const deriveInstanceLabel = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const resolveCurrentId = (state: Pick<InstancesStore, 'instances' | 'currentInstanceId' | 'defaultInstanceId'>): string | null => {
  const hasCurrent = state.currentInstanceId && state.instances.some((instance) => instance.id === state.currentInstanceId);
  if (hasCurrent) {
    return state.currentInstanceId;
  }
  const hasDefault = state.defaultInstanceId && state.instances.some((instance) => instance.id === state.defaultInstanceId);
  if (hasDefault) {
    return state.defaultInstanceId;
  }
  return state.instances[0]?.id ?? null;
};

export const useInstancesStore = create<InstancesStore>()(
  devtools(
    persist(
      (set, get) => ({
        instances: [],
        currentInstanceId: null,
        defaultInstanceId: null,
        hydrated: false,

        addInstance: ({ apiBaseUrl, label }) => {
          const normalized = normalizeApiBaseUrl(apiBaseUrl);
          const now = Date.now();
          const existing = get().instances.find((instance) => instance.apiBaseUrl === normalized.apiBaseUrl);
          if (existing) {
            set((state) => ({
              instances: state.instances.map((instance) =>
                instance.id === existing.id
                  ? {
                      ...instance,
                      label: label?.trim() || instance.label,
                      lastUsedAt: now,
                    }
                  : instance,
              ),
            }));
            return existing.id;
          }

          const id = createInstanceId();
          const nextInstance: Instance = {
            id,
            label: label?.trim() || deriveInstanceLabel(normalized.origin),
            origin: normalized.origin,
            apiBaseUrl: normalized.apiBaseUrl,
            createdAt: now,
            lastUsedAt: now,
          };

          set((state) => ({
            instances: [nextInstance, ...state.instances],
            currentInstanceId: state.currentInstanceId || id,
            defaultInstanceId: state.defaultInstanceId || id,
          }));

          return id;
        },

        updateInstance: (id, patch) => {
          set((state) => {
            const nextInstances = state.instances.map((instance) => {
              if (instance.id !== id) {
                return instance;
              }
              if (typeof patch.apiBaseUrl === 'string' && patch.apiBaseUrl.trim().length > 0) {
                const normalized = normalizeApiBaseUrl(patch.apiBaseUrl);
                return {
                  ...instance,
                  ...patch,
                  apiBaseUrl: normalized.apiBaseUrl,
                  origin: normalized.origin,
                  label: typeof patch.label === 'string' && patch.label.trim().length > 0
                    ? patch.label.trim()
                    : instance.label,
                };
              }
              return {
                ...instance,
                ...patch,
                label: typeof patch.label === 'string' && patch.label.trim().length > 0
                  ? patch.label.trim()
                  : instance.label,
              };
            });
            return { instances: nextInstances };
          });
        },

        removeInstance: (id) => {
          set((state) => {
            const instances = state.instances.filter((instance) => instance.id !== id);
            const currentInstanceId = state.currentInstanceId === id ? null : state.currentInstanceId;
            const defaultInstanceId = state.defaultInstanceId === id ? null : state.defaultInstanceId;
            const nextCurrent = resolveCurrentId({ instances, currentInstanceId, defaultInstanceId });
            const nextDefault = defaultInstanceId && instances.some((instance) => instance.id === defaultInstanceId)
              ? defaultInstanceId
              : instances[0]?.id ?? null;
            return {
              instances,
              currentInstanceId: nextCurrent,
              defaultInstanceId: nextDefault,
            };
          });
        },

        setCurrentInstance: (id) => {
          set((state) => {
            if (!id) {
              return { currentInstanceId: resolveCurrentId(state) };
            }
            const exists = state.instances.some((instance) => instance.id === id);
            return { currentInstanceId: exists ? id : state.currentInstanceId };
          });
        },

        setDefaultInstance: (id) => {
          set((state) => {
            if (!id) {
              return { defaultInstanceId: null };
            }
            const exists = state.instances.some((instance) => instance.id === id);
            return { defaultInstanceId: exists ? id : state.defaultInstanceId };
          });
        },

        touchInstance: (id) => {
          const now = Date.now();
          set((state) => ({
            instances: state.instances.map((instance) =>
              instance.id === id
                ? {
                    ...instance,
                    lastUsedAt: now,
                  }
                : instance,
            ),
          }));
        },

        markHydrated: () => set({ hydrated: true }),
      }),
      {
        name: STORAGE_KEY,
        storage: createJSONStorage(() => getSafeStorage()),
        partialize: (state) => ({
          instances: state.instances,
          currentInstanceId: state.currentInstanceId,
          defaultInstanceId: state.defaultInstanceId,
        }),
        onRehydrateStorage: () => (state) => {
          state?.markHydrated();
        },
      },
    ),
    {
      name: 'instances-store',
    },
  ),
);

export const resolveSelectedInstance = (): Instance | null => {
  const state = useInstancesStore.getState();
  const selectedId = resolveCurrentId(state);
  if (!selectedId) {
    return null;
  }
  return state.instances.find((instance) => instance.id === selectedId) ?? null;
};
