import { create } from 'zustand';

import { isAbsoluteFilePath, isFilePathWithinDirectory } from '@/lib/path-utils';
import { normalizePath } from '@/lib/pathNormalization';

import type { InstalledGuest } from './types.ts';

const isInside = (path: string, folder: string): boolean => (
  isFilePathWithinDirectory(path, folder) || (folder.endsWith('/') && path.toLowerCase().startsWith(folder.toLowerCase()))
);

export const isGuestInFolders = (guest: InstalledGuest, paths: readonly string[]): boolean => {
  if (!guest.folders?.length) return true;
  return guest.folders.some((raw) => {
    const folder = normalizePath(raw);
    return folder !== null && paths.some((path) => isInside(path, folder));
  });
};

const NO_PATHS: readonly string[] = [];

export const useGuestScopeStore = create<{ paths: readonly string[] }>(() => ({ paths: NO_PATHS }));

export const toGuestScopePaths = (candidates: ReadonlyArray<string | null | undefined>): string[] => (
  [...new Set(candidates.map(normalizePath).filter((path): path is string => path !== null))]
);

export const setGuestScopePaths = (candidates: ReadonlyArray<string | null | undefined>): void => {
  const paths = toGuestScopePaths(candidates);
  const current = useGuestScopeStore.getState().paths;
  if (paths.length === current.length && paths.every((path, index) => path === current[index])) return;
  useGuestScopeStore.setState({ paths: paths.length > 0 ? paths : NO_PATHS });
};

let lastScope: { guests: InstalledGuest[]; paths: readonly string[]; result: InstalledGuest[] } | null = null;

export const guestsInScope = (guests: InstalledGuest[], paths: readonly string[]): InstalledGuest[] => {
  if (lastScope && lastScope.guests === guests && lastScope.paths === paths) return lastScope.result;
  const filtered = guests.every((guest) => isGuestInFolders(guest, paths))
    ? guests
    : guests.filter((guest) => isGuestInFolders(guest, paths));
  const previous = lastScope?.result;
  const result = previous && previous.length === filtered.length && previous.every((guest, index) => guest === filtered[index])
    ? previous
    : filtered;
  lastScope = { guests, paths, result };
  return result;
};

export const isGuestTabHidden = (
  guestId: string,
  catalog: { loaded: boolean; guests: readonly InstalledGuest[] },
  paths: readonly string[],
): boolean => {
  if (!catalog.loaded) return true;
  const guest = catalog.guests.find((entry) => entry.id === guestId);
  return guest !== undefined && !isGuestInFolders(guest, paths);
};

export const keepGuestItemsInScope = <T extends { guestId: string }>(
  items: readonly T[],
  guests: readonly InstalledGuest[],
  paths: readonly string[],
): readonly T[] => {
  const outside = new Set(guests.filter((guest) => !isGuestInFolders(guest, paths)).map((guest) => guest.id));
  return items.some((item) => outside.has(item.guestId)) ? items.filter((item) => !outside.has(item.guestId)) : items;
};

export const isFullFolderPath = (value: string): boolean => isAbsoluteFilePath(value) || value.trim().startsWith('~/');

export const withPendingFolder = (folders: readonly string[], draft: string): string[] | null => {
  const folder = draft.trim();
  if (!folder || folders.includes(folder)) return [...folders];
  return isFullFolderPath(folder) ? [...folders, folder] : null;
};
