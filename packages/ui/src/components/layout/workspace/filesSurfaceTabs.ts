import type { ContextPanelDirectoryState, ContextPanelMode } from '@/stores/useUIStore';

/**
 * Open files are the Files surface's own tabs, not the workspace's. A zone's
 * strip lists each surface once, so every file tab, and the empty explorer
 * placeholder, folds into one Files entry with this id. The files themselves
 * are listed by the strip inside the Files surface.
 */
export const FILES_SURFACE_TAB_ID = 'workspace-surface:files';

type PanelTab = {
  id: string;
  mode: ContextPanelMode;
  touchedAt: number;
};

/**
 * Whether the Files editor is mounted: while Files has a real open file,
 * shown or hidden. Closing the last file unmounts it, as it always did.
 */
export const filesEditorMounted = (
  panel: Pick<ContextPanelDirectoryState, 'tabs' | 'hiddenFileTabs'> | undefined,
): boolean => [...(panel?.tabs ?? []), ...(panel?.hiddenFileTabs ?? [])]
  .some((tab) => tab.mode === 'file' && Boolean(tab.targetPath));

/**
 * The file tabs a zone's Files container is mounted for: the zone's own, plus
 * the hidden ones when Files is placed in this zone. Hidden Files stays
 * mounted, out of sight like a collapsed zone, so the editor keeps unsaved
 * edits until Files reopens.
 */
export const mountedFileTabs = <T extends { mode: ContextPanelMode }>(
  zoneTabs: readonly T[],
  hiddenFileTabs: readonly T[],
  filesPlacedHere: boolean,
): T[] => [
  ...zoneTabs.filter((tab) => tab.mode === 'file'),
  ...(filesPlacedHere ? hiddenFileTabs : []),
];

/**
 * The zone strip's entries in order. Files takes the place of its first file
 * tab, so it keeps its position among the other surfaces.
 */
export const workspaceStripEntries = <T extends PanelTab>(tabs: readonly T[]): Array<T | typeof FILES_SURFACE_TAB_ID> => {
  const entries: Array<T | typeof FILES_SURFACE_TAB_ID> = [];
  let hasFiles = false;
  for (const tab of tabs) {
    if (tab.mode !== 'file') {
      entries.push(tab);
    } else if (!hasFiles) {
      hasFiles = true;
      entries.push(FILES_SURFACE_TAB_ID);
    }
  }
  return entries;
};

/**
 * The surface a zone strip entry stands for. The Files entry is the whole
 * Files surface, so its Move rows move Files; file tabs are never entries.
 */
export const stripEntryMode = (id: string, tabs: readonly PanelTab[]): ContextPanelMode | null =>
  (id === FILES_SURFACE_TAB_ID ? 'file' : tabs.find((tab) => tab.id === id)?.mode ?? null);

/**
 * What closing these zone strip ids does. Other surfaces close their tabs;
 * Files is hidden instead, keeping its open files for when it reopens.
 */
export const splitWorkspaceStripClose = (ids: readonly string[]) => ({
  tabIds: ids.filter((id) => id !== FILES_SURFACE_TAB_ID),
  hidesFiles: ids.includes(FILES_SURFACE_TAB_ID),
});

/** The file tab Files shows when it comes to the front: the one used last. */
export const fileTabToActivate = <T extends PanelTab>(tabs: readonly T[]): T | null =>
  tabs.reduce<T | null>(
    (best, tab) => (tab.mode === 'file' && (!best || tab.touchedAt >= best.touchedAt) ? tab : best),
    null,
  );

/**
 * Turns a drag in the zone strip into the store's single-tab move. Files is a
 * group, so a drag involving it moves the other tab across the whole group:
 * after the last file when it sits to the left, before the first otherwise.
 */
export const reorderForStripDrag = (
  activeId: string,
  overId: string,
  tabs: readonly PanelTab[],
): [string, string] | null => {
  if (activeId !== FILES_SURFACE_TAB_ID && overId !== FILES_SURFACE_TAB_ID) return [activeId, overId];
  const otherId = activeId === FILES_SURFACE_TAB_ID ? overId : activeId;
  const otherIndex = tabs.findIndex((tab) => tab.id === otherId);
  const files = tabs.filter((tab) => tab.mode === 'file');
  const firstFile = files[0];
  const lastFile = files[files.length - 1];
  if (otherIndex === -1 || !firstFile || !lastFile) return null;
  return [otherId, otherIndex < tabs.indexOf(firstFile) ? lastFile.id : firstFile.id];
};
