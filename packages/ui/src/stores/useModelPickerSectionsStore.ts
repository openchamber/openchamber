import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ModelPickerSectionsStore = {
  collapsedSections: Record<string, boolean>;
  toggleSection: (key: string) => void;
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
