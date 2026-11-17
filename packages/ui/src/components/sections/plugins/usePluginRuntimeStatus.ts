import React from 'react';
import {
  getPluginsConfigDirectory,
  getPluginsScopeKey,
  getPluginUpdateKey,
  usePluginsStore,
  type PluginPackageUpdate,
} from '@/stores/usePluginsStore';
import {
  findRuntimeMatches,
  resolveLoadState,
  resolveUpdateFlag,
  type PluginLoadState,
  type PluginRuntimeTarget,
  type PluginUpdateFlag,
} from './pluginLoadState';

export type PluginRuntimeStatus =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'known'; load: PluginLoadState; update: PluginUpdateFlag; target: PluginRuntimeTarget };

export function usePluginRuntimeStatus(target: PluginRuntimeTarget | null): PluginRuntimeStatus {
  const runtime = usePluginsStore((state) => state.runtime);
  const scope = getPluginsScopeKey(getPluginsConfigDirectory());
  return React.useMemo((): PluginRuntimeStatus => {
    if (runtime.kind === 'idle' || runtime.scope !== scope) return { kind: 'loading' };
    if (runtime.kind === 'failed' || !target) return { kind: 'unknown' };
    const matched = findRuntimeMatches(target, runtime.plugins);
    return { kind: 'known', load: resolveLoadState(matched), update: resolveUpdateFlag(matched), target };
  }, [runtime, scope, target]);
}

export function usePluginPackageUpdate(target: PluginRuntimeTarget | null): PluginPackageUpdate | null {
  const scope = getPluginsScopeKey(getPluginsConfigDirectory());
  const key = target?.kind === 'package' ? getPluginUpdateKey(scope, target.target) : null;
  return usePluginsStore((state) => (key ? state.packageUpdates[key] ?? null : null));
}
