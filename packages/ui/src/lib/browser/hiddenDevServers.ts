import React from 'react';
import { z } from 'zod';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * Ports the user hid from the browser panel's list of running servers.
 *
 * Discovery lists every listening loopback port, and on some machines most of
 * them belong to the OS or to other apps. The user hides those once; the port
 * stays hidden whenever something listens on it again. Kept per runtime, since
 * each machine has its own noise.
 */
const STORAGE_KEY = 'oc.browser.hiddenDevServerPorts.v1';
const storedSchema = z.record(z.string(), z.array(z.number().int().positive()));
type StoredHiddenPorts = z.infer<typeof storedSchema>;

const listeners = new Set<() => void>();
const EMPTY: readonly number[] = [];
let cache: { raw: string | null; value: StoredHiddenPorts } | null = null;

const read = (): StoredHiddenPorts => {
  const raw = getSafeStorage().getItem(STORAGE_KEY);
  if (cache && cache.raw === raw) return cache.value;
  let value: StoredHiddenPorts = {};
  if (raw !== null) {
    try {
      const parsed = storedSchema.safeParse(JSON.parse(raw));
      if (parsed.success) value = parsed.data;
    } catch {
      value = {};
    }
  }
  cache = { raw, value };
  return value;
};

const write = (next: StoredHiddenPorts): void => {
  getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(next));
  for (const listener of listeners) listener();
};

export const getHiddenDevServerPorts = (runtimeKey = getRuntimeKey()): readonly number[] => (
  read()[runtimeKey] ?? EMPTY
);

export const hideDevServerPort = (port: number): void => {
  const runtimeKey = getRuntimeKey();
  const stored = read();
  const current = stored[runtimeKey] ?? [];
  if (current.includes(port)) return;
  write({ ...stored, [runtimeKey]: [...current, port].sort((left, right) => left - right) });
};

export const showHiddenDevServerPorts = (): void => {
  const runtimeKey = getRuntimeKey();
  const stored = read();
  if (!stored[runtimeKey]) return;
  const next = { ...stored };
  delete next[runtimeKey];
  write(next);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useHiddenDevServerPorts = (): readonly number[] => (
  React.useSyncExternalStore(subscribe, () => getHiddenDevServerPorts(), () => EMPTY)
);
