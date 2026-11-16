
import { create } from 'zustand';

import { normalizePath } from '@/lib/pathNormalization';

import { listSpaceArchives, type SpaceArchive } from './spaces-api';

type SpaceArchivesState = {
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

export const ensureSpaceArchives = (): void => {
  if (useSpaceArchivesStore.getState().byDirectory !== null) return;
  void refreshSpaceArchives().catch(() => {});
};

export const isSpaceArchiveDirectory = (directory: string | null | undefined): boolean => {
  const key = normalizePath(directory);
  return key !== null && (useSpaceArchivesStore.getState().byDirectory?.has(key) ?? false);
};

export const useSpaceArchiveOf = (directory: string | null | undefined): SpaceArchive | null => {
  const key = normalizePath(directory);
  return useSpaceArchivesStore((state) => (key ? state.byDirectory?.get(key) ?? null : null));
};
