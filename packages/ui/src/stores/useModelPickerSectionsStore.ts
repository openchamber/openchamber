import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Persisted collapsed state for the collapsible sections (accordions) in the
 * model/provider picker (`ModelPickerList`): the `favorites` and `recent`
 * sections plus each `provider:<id>` group. Section keys are stable and shared
 * across every picker surface, so collapsing a provider in one picker is
 * remembered everywhere and survives remounts and full page reloads.
 *
 * Only collapsed keys are stored (presence === collapsed); the default for any
 * unknown key is expanded.
 */
type ModelPickerSectionsStore = {
  collapsedSections: Record<string, boolean>;
  toggleSection: (key: string) => void;
};

export const useModelPickerSectionsStore = create<ModelPickerSectionsStore>()(
  persist(
    (set) => ({
      collapsedSections: {},
      toggleSection: (key) =>
        set((state) => {
          const next = { ...state.collapsedSections };
          if (next[key]) delete next[key];
          else next[key] = true;
          return { collapsedSections: next };
        }),
    }),
    {
      name: 'model-picker-collapsed-sections',
      version: 1,
    },
  ),
);
