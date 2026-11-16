import React from 'react';

const announcedByDirectory = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const setAnnouncedDevServers = (directory: string, urls: readonly string[]): void => {
  const key = directory.trim();
  if (!key) return;
  if (urls.length === 0) announcedByDirectory.delete(key);
  else announcedByDirectory.set(key, [...urls]);
  emit();
};

export const clearAnnouncedDevServers = (directory: string): void => {
  if (announcedByDirectory.delete(directory.trim())) emit();
};

const EMPTY: readonly string[] = [];

const getAnnouncedDevServers = (directory: string): readonly string[] => (
  announcedByDirectory.get(directory.trim()) ?? EMPTY
);

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useAnnouncedDevServers = (directory: string): readonly string[] => (
  React.useSyncExternalStore(
    subscribe,
    () => getAnnouncedDevServers(directory),
    () => EMPTY,
  )
);
