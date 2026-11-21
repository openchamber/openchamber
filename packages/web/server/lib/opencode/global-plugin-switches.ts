import { isRecord, isString } from '../shared/object-guards.js';
import { getLayerError, readConfigLayers, writeConfig } from './config-files.js';
import type { OpenCodeConfigLayers } from './config-files.js';
import type { PluginDenial, PluginSwitchRead, PluginSwitchStore } from './plugin-switches.js';

const PLUGIN_RESOURCE_PREFIX = 'plugin:';

const isPluginDenialStatement = (value: unknown): value is PluginDenial => (
  isRecord(value)
  && value.action === 'integration.use'
  && value.effect === 'deny'
  && isString(value.resource)
  && value.resource.startsWith(PLUGIN_RESOURCE_PREFIX)
  && value.resource.length > PLUGIN_RESOURCE_PREFIX.length
);

export const createGlobalConfigPluginSwitchStore = ({
  readLayers = () => readConfigLayers(null),
  writeLayer = writeConfig,
}: {
  readLayers?: () => OpenCodeConfigLayers;
  writeLayer?: typeof writeConfig;
} = {}): PluginSwitchStore => {
  const globalSources = (layers: OpenCodeConfigLayers) => {
    const sources = [{ config: layers.userConfig, filePath: layers.paths.userPath }];
    if (layers.paths.userOverridePath) {
      sources.push({ config: layers.userOverrideConfig, filePath: layers.paths.userOverridePath });
    }
    return sources;
  };

  const read = (): PluginSwitchRead => {
    try {
      const layers = readLayers();
      const sources = globalSources(layers);
      for (const source of sources) {
        const failed = getLayerError(layers, source.filePath);
        if (failed) return { ok: false, error: new Error(failed.message) };
      }
      const resources = new Set<string>();
      for (const source of sources) {
        const policies = Array.isArray(source.config.policies) ? source.config.policies : [];
        for (const statement of policies) {
          if (isPluginDenialStatement(statement)) resources.add(statement.resource);
        }
      }
      return { ok: true, resources: [...resources] };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const set = (resource: string, enabled: boolean) => {
    const layers = readLayers();
    const sources = globalSources(layers);
    for (const source of sources) {
      const failed = getLayerError(layers, source.filePath);
      if (failed) {
        throw Object.assign(new Error(failed.message), { code: 'CONFIG_INVALID' });
      }
    }

    if (!enabled) {
      const target = sources[0];
      if (!target) return { changed: false };
      const alreadyDenied = sources.some((source) => (
        Array.isArray(source.config.policies)
        && source.config.policies.some((entry) => isPluginDenialStatement(entry) && entry.resource === resource)
      ));
      if (alreadyDenied) return { changed: false };
      const policies = Array.isArray(target.config.policies) ? [...target.config.policies] : [];
      policies.push({ action: 'integration.use', resource, effect: 'deny' });
      target.config.policies = policies;
      writeLayer(target.config, target.filePath);
      return { changed: true };
    }

    let changed = false;
    for (const source of sources) {
      if (!Array.isArray(source.config.policies)) continue;
      const kept = source.config.policies.filter(
        (entry) => !(isPluginDenialStatement(entry) && entry.resource === resource),
      );
      if (kept.length === source.config.policies.length) continue;
      if (kept.length === 0) {
        delete source.config.policies;
      } else {
        source.config.policies = kept;
      }
      writeLayer(source.config, source.filePath);
      changed = true;
    }
    return { changed };
  };

  const denials = () => {
    const current = read();
    if (!current.ok) return [];
    return current.resources.map((resource): PluginDenial => ({ action: 'integration.use', resource, effect: 'deny' }));
  };

  return {
    get filePath() {
      try {
        return readLayers().paths.userPath;
      } catch {
        return '';
      }
    },
    read,
    set,
    denials,
  };
};

export const createAdaptivePluginSwitchStore = ({
  managedStore,
  globalStore,
  isGlobalMode,
}: {
  managedStore: PluginSwitchStore;
  globalStore: PluginSwitchStore;
  isGlobalMode: () => boolean;
}): PluginSwitchStore => ({
  get filePath() {
    return (isGlobalMode() ? globalStore : managedStore).filePath;
  },
  read: () => (isGlobalMode() ? globalStore : managedStore).read(),
  set: (resource, enabled) => (isGlobalMode() ? globalStore : managedStore).set(resource, enabled),
  denials: () => (isGlobalMode() ? globalStore : managedStore).denials(),
});
