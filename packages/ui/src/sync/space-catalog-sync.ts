import { getRuntimeKey } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { getSpaceMark, isSpaceDirectoryStopped, useSpacesStore, type SpaceMark } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';

const SOURCE = 'spaceProjectKnown';

/** The spaces whose project is named now and was not, or was another, in the previous list. */
export const spacesWithNewProject = (next: ReadonlyMap<string, SpaceMark>, previous: ReadonlyMap<string, SpaceMark>): Set<string> => {
  const changed = new Set<string>();
  for (const mark of next.values()) {
    if (mark.projectDirectory && previous.get(mark.id)?.projectDirectory !== mark.projectDirectory) changed.add(mark.id);
  }
  return changed;
};

/**
 * The space folders whose model catalog this page loaded: the active one, and those whose snapshot
 * says it was loaded, which the saved selections of earlier visits do not. A stopped space is
 * left out; every read of it would be the dispatcher's refusal.
 */
const loadedSpaceFolders = (): string[] => {
  const config = useConfigStore.getState();
  const loaded = new Set([config.activeDirectoryKey]);
  for (const [directory, snapshot] of Object.entries(config.directoryScoped)) {
    if (snapshot.providersLoaded === true) loaded.add(directory);
  }
  return [...loaded].filter((directory) => spaceIdOfDirectory(directory) !== null && !isSpaceDirectoryStopped(directory));
};

/** The loaded space folders that lie inside one of the given spaces. */
export const foldersOfSpaces = (spaceIds: ReadonlySet<string>, folders: readonly string[]): string[] => (
  folders.filter((directory) => {
    const spaceId = spaceIdOfDirectory(directory);
    return spaceId !== null && spaceIds.has(spaceId);
  })
);

/**
 * The loaded space folders whose space was made from `projectDirectory`. Their models are grouped
 * under that host project's providers, so a catalog event there concerns them too.
 */
export const spaceFoldersOfProject = (projectDirectory: string): string[] => loadedSpaceFolders().filter((directory) => {
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId !== null && getSpaceMark(spaceId)?.projectDirectory === projectDirectory;
});

/**
 * The models of a folder inside an isolated space are grouped under the host's providers of the
 * project the space was made from, see `getProvidersForConfig`. A space made while the page is
 * open is chatted in before the list names its project, so its catalog was read without the
 * project's own providers. When a space's project becomes known, the catalogs this page already
 * loaded for that space's folders are read again; no other folder is read.
 */
export const subscribeSpaceCatalogs = (runtimeKey: string): (() => void) => useSpacesStore.subscribe((state, previous) => {
  if (state.spaces === previous.spaces || runtimeKey !== getRuntimeKey()) return;
  const changed = spacesWithNewProject(state.spaces, previous.spaces);
  if (changed.size === 0) return;
  const config = useConfigStore.getState();
  for (const directory of foldersOfSpaces(changed, loadedSpaceFolders())) {
    void config.loadProviders({ directory, source: SOURCE, fresh: true });
  }
});
