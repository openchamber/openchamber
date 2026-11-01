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

/**
 * The sections editor's state on this device, never stored: whether the
 * manager is open, the section being edited (the sidebar previews it in its
 * place while it is), and what a new pin list is being made for.
 */
type PinListRequest = { pin: (listId: string) => void };
/** The phone's Pin to: a sheet listing Pinned and the user's lists for one work. */
type PinToRequest = { current: string | null; pin: (list: string | null) => void; unpin: () => void };

type SidebarSectionsUiState = {
  managerOpen: boolean;
  /** The section being edited, as it stands; the sidebar draws it in place of the saved one. */
  draft: CustomSidebarSection | null;
  /** The draft is a new section, not yet in the saved list. */
  draftIsNew: boolean;
  /** How many works (or projects, for a group of projects) the draft lists right now; null while nothing measured it. */
  draftMatchCount: number | null;
  pinListRequest: PinListRequest | null;
  pinToRequest: PinToRequest | null;
};

export const useSidebarSectionsUiStore = create<SidebarSectionsUiState>(() => ({
  managerOpen: false,
  draft: null,
  draftIsNew: false,
  draftMatchCount: null,
  pinListRequest: null,
  pinToRequest: null,
}));

export const openSectionsManager = (): void => useSidebarSectionsUiStore.setState({ managerOpen: true });
export const closeSectionsManager = (): void => useSidebarSectionsUiStore.setState({ managerOpen: false, draft: null, draftIsNew: false, draftMatchCount: null });
export const editSection = (section: CustomSidebarSection, isNew: boolean): void => useSidebarSectionsUiStore.setState({ managerOpen: true, draft: section, draftIsNew: isNew });
export const updateSectionDraft = (draft: CustomSidebarSection): void => useSidebarSectionsUiStore.setState({ draft });
export const discardSectionDraft = (): void => useSidebarSectionsUiStore.setState({ draft: null, draftIsNew: false, draftMatchCount: null });

/** Asks for a new pin list's name; `pin` files the work into the list once it exists. */
export const requestNewPinList = (pin: (listId: string) => void): void => useSidebarSectionsUiStore.setState({ pinListRequest: { pin } });
/**
 * The phone's swipe Pin: with no pin lists it pins to Pinned or unpins at
 * once, as before; with lists it asks which one.
 */
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

/** Whether one more section of the user's own fits; the stored list keeps at most `SIDEBAR_SECTIONS_MAX`. */
export const canAddSidebarSection = (sections: readonly SidebarSectionEntry[]): boolean => (
  sections.filter((entry) => entry.kind === 'custom').length < SIDEBAR_SECTIONS_MAX
);

/** Saves the draft in its place, a new one under the Pinned section, and closes the editor. */
export const commitSectionDraft = (): void => {
  const { draft, draftIsNew } = useSidebarSectionsUiStore.getState();
  if (!draft) return;
  const sections = useSessionDisplayStore.getState().sections;
  // Past the limit the stored list would drop a section the user already has.
  if (draftIsNew && !canAddSidebarSection(sections)) return;
  const next = draftIsNew
    ? insertAfterPinned(sections, draft)
    : sections.map((entry) => (entry.kind === 'custom' && entry.id === draft.id ? draft : entry));
  saveSidebarSections(next);
  discardSectionDraft();
};

/**
 * Deletes a pin list. Sections stop asking for it, and a section left asking
 * for no pin list at all goes with it (the one made with the list among them):
 * without its pins its other chips would list far more than it did. Pins filed
 * in the list stay pinned and show in their projects with the pin mark.
 */
export const deleteSidebarPinList = (id: string): void => {
  const store = useSessionDisplayStore.getState();
  store.setPinLists(store.pinLists.filter((list) => list.id !== id));
  void updateDesktopSettings({ sidebarPinLists: useSessionDisplayStore.getState().pinLists });
  const sections = store.sections.flatMap((entry): SidebarSectionEntry[] => {
    if (entry.kind !== 'custom' || !entry.filter.pins.includes(id)) return [entry];
    const pins = entry.filter.pins.filter((pin) => pin !== id);
    return pins.length === 0 ? [] : [{ ...entry, filter: { ...entry.filter, pins } }];
  });
  if (sections.length !== store.sections.length || sections.some((entry, index) => entry !== store.sections[index])) saveSidebarSections(sections);
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

/**
 * A new pin list with a section that shows it, right under Pinned: a list no
 * section shows would leave its works in their projects with a pin mark.
 */
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
