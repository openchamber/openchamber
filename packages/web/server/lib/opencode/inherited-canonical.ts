import { readSectionEntry, toProviderEntity } from './config-v2.js';
import { isRecord } from '../shared/object-guards.js';

export interface ProviderConfigLayers<Config> {
  customConfig: Config;
  projectConfig: Config;
  userOverrideConfig: Config;
  userConfig: Config;
  paths: { customPath: string | null | undefined; projectPath: string | null | undefined; userOverridePath: string | null; userPath: string };
}

const layersByPriority = <Config>(layers: ProviderConfigLayers<Config>) => [
  { config: layers.customConfig, path: layers.paths.customPath },
  { config: layers.projectConfig, path: layers.paths.projectPath },
  { config: layers.userOverrideConfig, path: layers.paths.userOverridePath },
  { config: layers.userConfig, path: layers.paths.userPath },
];

export function readInheritedProviderCanonical<Config>(layers: ProviderConfigLayers<Config>, providerId: string) {
  const byPriority = layersByPriority(layers);
  const owner = byPriority.findIndex((layer) => readSectionEntry(layer.config, 'providers', providerId).value !== undefined);
  if (owner < 0) return null;
  for (const { config, path } of byPriority.slice(owner + 1)) {
    const { value } = readSectionEntry(config, 'providers', providerId);
    const canonical = value === undefined ? undefined : toProviderEntity(value).canonical;
    if (canonical && path) return { provider: canonical, path };
  }
  return null;
}

// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/config/plugin/provider.ts#L179 overlayProvider copies the source's settings, headers and body before the entry's own values.
export function canonicalSourceConnectionError<Config>(layers: ProviderConfigLayers<Config>, providerId: string, canonical: string) {
  const byPriority = layersByPriority(layers);
  const chosenBefore = byPriority.some(({ config }) => {
    const { value } = readSectionEntry(config, 'providers', providerId);
    return value !== undefined && toProviderEntity(value).canonical === canonical;
  });
  if (chosenBefore) return null;
  for (const { config, path } of byPriority) {
    const { value } = readSectionEntry(config, 'providers', canonical);
    if (isRecord(value) && ['settings', 'headers', 'body'].some((key) => isRecord(value[key]) && Object.keys(value[key]).length > 0)) {
      return `Provider "${canonical}" sets its own connection settings in ${path || 'OpenCode config'}, and OpenCode would send them to this provider's endpoint. Choose a catalog provider instead.`;
    }
  }
  return null;
}
