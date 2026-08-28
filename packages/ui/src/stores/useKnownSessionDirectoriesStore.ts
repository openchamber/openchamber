import { create } from 'zustand';

const EMPTY_DIRECTORIES: ReadonlySet<string> = new Set();

type KnownSessionDirectoriesStore = {
  directories: ReadonlySet<string>;
  setDirectories: (directories: ReadonlySet<string>) => void;
  clearDirectories: () => void;
};

const setsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

export const useKnownSessionDirectoriesStore = create<KnownSessionDirectoriesStore>((set) => ({
  directories: EMPTY_DIRECTORIES,
  setDirectories: (directories) => set((state) => (
    setsEqual(state.directories, directories) ? state : { directories }
  )),
  clearDirectories: () => set((state) => (
    state.directories.size === 0 ? state : { directories: EMPTY_DIRECTORIES }
  )),
}));
