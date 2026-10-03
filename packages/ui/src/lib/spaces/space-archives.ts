// The chats of deleted isolated spaces, kept on the Archive page and read-only (DESIGN.md,
// decision 9 and journey step 7). The host names each archive by the directory that holds its
// chats; this store answers, for a chat's directory, which deleted space it came from. It stays
// filled while the feature's switch is off, because those chats stay; it is runtime-scoped and
// reset when the runtime endpoint changes. The server refuses to run an archived chat whatever
// this store says; the store only lets the screen say so first.

import { create } from 'zustand';

import { normalizePath } from '@/lib/pathNormalization';

import { listSpaceArchives, type SpaceArchive } from './spaces-api';

type SpaceArchivesState = {
  /**
   * By the directory that holds the chats, normalized as the session lists compare directories;
   * null until the host answered once for this runtime.
   */
  byDirectory: ReadonlyMap<string, SpaceArchive> | null;
  resetForRuntimeSwitch: () => void;
};

let generation = 0;
let reading: Promise<void> | null = null;

export const useSpaceArchivesStore = create<SpaceArchivesState>()((set) => ({
  byDirectory: null,
  resetForRuntimeSwitch: () => {
    generation += 1;
    reading = null;
    set({ byDirectory: null });
  },
}));

/**
 * Reads the archives again. A read that fails leaves the last answer in place, so a chat known
 * to be archived never reads as live; one a runtime switch overtook is dropped.
 */
export const refreshSpaceArchives = (): Promise<void> => {
  if (reading) return reading;
  const started = generation;
  const read = listSpaceArchives()
    .then((archives) => {
      if (started !== generation) return;
      const byDirectory = new Map<string, SpaceArchive>();
      for (const archive of archives) {
        const directory = normalizePath(archive.directory);
        if (directory) byDirectory.set(directory, archive);
      }
      useSpaceArchivesStore.setState({ byDirectory });
    })
    .finally(() => {
      if (reading === read) reading = null;
    });
  reading = read;
  return read;
};

/** Reads the archives once for this runtime, when nothing has been read yet; a failure is left for the next call. */
export const ensureSpaceArchives = (): void => {
  if (useSpaceArchivesStore.getState().byDirectory !== null) return;
  void refreshSpaceArchives().catch(() => {});
};

/** The deleted space whose chats a directory holds, or null. */
export const useSpaceArchiveOf = (directory: string | null | undefined): SpaceArchive | null => {
  const key = normalizePath(directory);
  return useSpaceArchivesStore((state) => (key ? state.byDirectory?.get(key) ?? null : null));
};
