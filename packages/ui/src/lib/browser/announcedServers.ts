import React from 'react';

/**
 * Addresses the servers of one directory announced when they started.
 *
 * Auto-discovery starts a command and watches what it prints. When several
 * servers announce themselves — a gateway and the apps behind it, an API beside
 * a site — there is no honest way to pick one, so the candidates are parked
 * here and the browser panel offers them.
 *
 * These beat port discovery when both are available: an app served under a base
 * path announces that path, and a listening socket cannot reveal it.
 *
 * Kept in memory only. They describe one run of one command; a stored copy is
 * exactly the kind of stale address that sent the panel to the wrong page.
 */
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
