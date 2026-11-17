import { getRuntimeKey } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { getSpaceMark, isSpaceDirectoryStopped, useSpacesStore, type SpaceMark } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';

const SOURCE = 'spaceProjectKnown';

export const spacesWithNewProject = (next: ReadonlyMap<string, SpaceMark>, previous: ReadonlyMap<string, SpaceMark>): Set<string> => {
  const changed = new Set<string>();
  for (const mark of next.values()) {
    if (mark.projectDirectory && previous.get(mark.id)?.projectDirectory !== mark.projectDirectory) changed.add(mark.id);
  }
  return changed;
};

const loadedSpaceFolders = (): string[] => {
  const config = useConfigStore.getState();
  const loaded = new Set([config.activeDirectoryKey]);
  for (const [directory, snapshot] of Object.entries(config.directoryScoped)) {
    if (snapshot.providersLoaded === true) loaded.add(directory);
  }
  return [...loaded].filter((directory) => spaceIdOfDirectory(directory) !== null && !isSpaceDirectoryStopped(directory));
};

export const foldersOfSpaces = (spaceIds: ReadonlySet<string>, folders: readonly string[]): string[] => (
  folders.filter((directory) => {
    const spaceId = spaceIdOfDirectory(directory);
    return spaceId !== null && spaceIds.has(spaceId);
  })
);

export const spaceFoldersOfProject = (projectDirectory: string): string[] => loadedSpaceFolders().filter((directory) => {
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId !== null && getSpaceMark(spaceId)?.projectDirectory === projectDirectory;
});

export const subscribeSpaceCatalogs = (runtimeKey: string): (() => void) => useSpacesStore.subscribe((state, previous) => {
  if (state.spaces === previous.spaces || runtimeKey !== getRuntimeKey()) return;
  const changed = spacesWithNewProject(state.spaces, previous.spaces);
  if (changed.size === 0) return;
  const config = useConfigStore.getState();
  for (const directory of foldersOfSpaces(changed, loadedSpaceFolders())) {
    void config.loadProviders({ directory, source: SOURCE, fresh: true });
  }
});
