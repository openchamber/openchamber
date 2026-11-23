import { create } from 'zustand';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  createSidebarSectionId,
  EMPTY_SIDEBAR_SECTION_FILTER,
  SIDEBAR_PIN_LISTS_MAX,
  SIDEBAR_SECTIONS_MAX,
  type CustomSidebarSection,
  type SidebarPinList,
  type SidebarSectionEntry,
} from '@/lib/sidebarSections';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { nextSidebarPageOrder } from '../pages/sidebarPageOrder';

type PinListRequest = { pin: (listId: string) => void };
type PinToRequest = { current: string | null; pin: (list: string | null) => void; unpin: () => void };

type SidebarSectionsUiState = {
  managerOpen: boolean;
  pagesListOpen: boolean;
  draft: CustomSidebarSection | null;
  draftIsNew: boolean;
  draftMatchCount: number | null;
  pinListRequest: PinListRequest | null;
  pinToRequest: PinToRequest | null;
};

export const useSidebarSectionsUiStore = create<SidebarSectionsUiState>(() => ({
  managerOpen: false,
  pagesListOpen: false,
  draft: null,
  draftIsNew: false,
  draftMatchCount: null,
  pinListRequest: null,
  pinToRequest: null,
}));

export const openSectionsManager = (): void => useSidebarSectionsUiStore.setState({ managerOpen: true });
export const closeSectionsManager = (): void => useSidebarSectionsUiStore.setState({ managerOpen: false, pagesListOpen: false, draft: null, draftIsNew: false, draftMatchCount: null });
export const openSidebarPagesList = (): void => useSidebarSectionsUiStore.setState({ pagesListOpen: true });
export const closeSidebarPagesList = (): void => useSidebarSectionsUiStore.setState({ pagesListOpen: false });
export const editSection = (section: CustomSidebarSection, isNew: boolean): void => useSidebarSectionsUiStore.setState({ managerOpen: true, pagesListOpen: false, draft: section, draftIsNew: isNew });
export const updateSectionDraft = (draft: CustomSidebarSection): void => useSidebarSectionsUiStore.setState({ draft });
export const discardSectionDraft = (): void => useSidebarSectionsUiStore.setState({ draft: null, draftIsNew: false, draftMatchCount: null });

export const requestNewPinList = (pin: (listId: string) => void): void => useSidebarSectionsUiStore.setState({ pinListRequest: { pin } });
export const requestPinTo = (request: PinToRequest): void => {
  if (useSessionDisplayStore.getState().pinLists.length === 0) {
    if (request.current) request.unpin(); else request.pin(null);
    return;
  }
  useSidebarSectionsUiStore.setState({ pinToRequest: request });
};
export const closePinToRequest = (): void => useSidebarSectionsUiStore.setState({ pinToRequest: null });
export const closePinListRequest = (): void => useSidebarSectionsUiStore.setState({ pinListRequest: null });

export const saveSidebarSections = (sections: SidebarSectionEntry[]): void => {
  const store = useSessionDisplayStore.getState();
  store.setSections(sections);
  void updateDesktopSettings({ sidebarSections: useSessionDisplayStore.getState().sections });
};

export const setSidebarSectionHidden = (id: string, hidden: boolean): void => {
  const store = useSessionDisplayStore.getState();
  const next = hidden ? [...store.hiddenSections, id] : store.hiddenSections.filter((entry) => entry !== id);
  store.setHiddenSections(next);
  void updateDesktopSettings({ sidebarHiddenSections: useSessionDisplayStore.getState().hiddenSections });
};

export const saveSidebarPageOrder = (arranged: readonly string[]): void => {
  const store = useSessionDisplayStore.getState();
  store.setPageOrder(nextSidebarPageOrder(arranged, store.pageOrder));
  void updateDesktopSettings({ sidebarPageOrder: useSessionDisplayStore.getState().pageOrder });
};

export const setSidebarPageHidden = (id: string, hidden: boolean): void => {
  const store = useSessionDisplayStore.getState();
  const next = hidden ? [...store.hiddenPages, id] : store.hiddenPages.filter((entry) => entry !== id);
  store.setHiddenPages(next);
  void updateDesktopSettings({ sidebarHiddenPages: useSessionDisplayStore.getState().hiddenPages });
};

export const canAddSidebarSection = (sections: readonly SidebarSectionEntry[]): boolean => (
  sections.filter((entry) => entry.kind === 'custom').length < SIDEBAR_SECTIONS_MAX
);

export const commitSectionDraft = (): void => {
  const { draft, draftIsNew } = useSidebarSectionsUiStore.getState();
  if (!draft) return;
  const sections = useSessionDisplayStore.getState().sections;
  if (draftIsNew && !canAddSidebarSection(sections)) return;
  const next = draftIsNew
    ? insertAfterPinned(sections, draft)
    : sections.map((entry) => (entry.kind === 'custom' && entry.id === draft.id ? draft : entry));
  saveSidebarSections(next);
  discardSectionDraft();
};

export const deleteSidebarPinList = (id: string): void => {
  const store = useSessionDisplayStore.getState();
  store.setPinLists(store.pinLists.filter((list) => list.id !== id));
  void updateDesktopSettings({ sidebarPinLists: useSessionDisplayStore.getState().pinLists });
  stopAskingFor('pins', id);
};

export const removeFolderFromSections = (id: string): void => stopAskingFor('folders', id);

const stopAskingFor = (category: 'pins' | 'folders', id: string): void => {
  const current = useSessionDisplayStore.getState().sections;
  const sections = current.flatMap((entry): SidebarSectionEntry[] => {
    if (entry.kind !== 'custom' || !entry.filter[category].includes(id)) return [entry];
    const values = entry.filter[category].filter((value) => value !== id);
    return values.length === 0 ? [] : [{ ...entry, filter: { ...entry.filter, [category]: values } }];
  });
  if (sections.length !== current.length || sections.some((entry, index) => entry !== current[index])) saveSidebarSections(sections);
};

export const deleteSidebarSection = (id: string): void => {
  saveSidebarSections(useSessionDisplayStore.getState().sections.filter((entry) => entry.kind !== 'custom' || entry.id !== id));
  const hidden = useSessionDisplayStore.getState().hiddenSections;
  if (hidden.includes(id)) setSidebarSectionHidden(id, false);
};

const insertAfterPinned = (sections: readonly SidebarSectionEntry[], section: SidebarSectionEntry): SidebarSectionEntry[] => {
  const pinnedIndex = sections.findIndex((entry) => entry.kind === 'builtin' && entry.id === 'pinned');
  const next = [...sections];
  next.splice(pinnedIndex >= 0 ? pinnedIndex + 1 : 0, 0, section);
  return next;
};

export const createPinListWithSection = (name: string): SidebarPinList | null => {
  const trimmed = name.trim();
  const store = useSessionDisplayStore.getState();
  if (!trimmed || store.pinLists.length >= SIDEBAR_PIN_LISTS_MAX || !canAddSidebarSection(store.sections)) return null;
  const list: SidebarPinList = { id: createSidebarSectionId(), name: trimmed };
  store.setPinLists([...store.pinLists, list]);
  void updateDesktopSettings({ sidebarPinLists: useSessionDisplayStore.getState().pinLists });
  const section: CustomSidebarSection = {
    kind: 'custom',
    id: createSidebarSectionId(),
    name: trimmed,
    grouping: 'time',
    filter: { ...EMPTY_SIDEBAR_SECTION_FILTER, pins: [list.id] },
    claims: true,
    hideWhenEmpty: true,
  };
  saveSidebarSections(insertAfterPinned(useSessionDisplayStore.getState().sections, section));
  return list;
};
