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
  /**
   * Sets a section open or closed outright, for a picker whose providers start
   * closed (the phone's): an opened one is kept as `open:<key>`, since the
   * default there is closed.
   */
  setSectionCollapsed: (key: string, collapsed: boolean) => void;
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
      setSectionCollapsed: (key, collapsed) =>
        set((state) => {
          const next = { ...state.collapsedSections };
          if (collapsed) {
            next[key] = true;
            delete next[`open:${key}`];
          } else {
            delete next[key];
            next[`open:${key}`] = true;
          }
          return { collapsedSections: next };
        }),
    }),
    {
      name: 'model-picker-collapsed-sections',
      version: 1,
    },
  ),
);
