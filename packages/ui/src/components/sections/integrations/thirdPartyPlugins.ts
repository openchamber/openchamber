import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import type { PluginEntry, RegistryResult } from '@/stores/usePluginsStore';

export interface ThirdPartyPluginDefinition {
  id: string;
  packageName: string;
  providerId: string;
  icon: IconName;
  /** Brand mark tint (e.g. Claude orange); neutral marks use text-foreground. */
  brandClassName: string;
  nameKey: I18nKey;
  descriptionKey: I18nKey;
  homepage: string;
}

export const THIRD_PARTY_PLUGINS: readonly ThirdPartyPluginDefinition[] = [
  {
    id: 'opencode-claude',
    packageName: '@openchamber/opencode-claude',
    providerId: 'claude-code',
    icon: 'claude-code',
    brandClassName: 'text-[#D97757]',
    nameKey: 'settings.integrations.thirdParty.opencodeClaude.name',
    descriptionKey: 'settings.integrations.thirdParty.opencodeClaude.description',
    homepage: 'https://github.com/openchamber/opencode-claude',
  },
  {
    id: 'opencode-commandcode',
    packageName: '@openchamber/opencode-commandcode',
    providerId: 'command-code',
    icon: 'command-code',
    brandClassName: 'text-foreground',
    nameKey: 'settings.integrations.thirdParty.opencodeCommandcode.name',
    descriptionKey: 'settings.integrations.thirdParty.opencodeCommandcode.description',
    homepage: 'https://github.com/openchamber/opencode-commandcode',
  },
  {
    id: 'opencode-cursor-oauth',
    packageName: '@openchamber/opencode-cursor',
    providerId: 'cursor',
    icon: 'cursor',
    brandClassName: 'text-foreground',
    nameKey: 'settings.integrations.thirdParty.opencodeCursorOauth.name',
    descriptionKey: 'settings.integrations.thirdParty.opencodeCursorOauth.description',
    homepage: 'https://github.com/openchamber/opencode-cursor',
  },
] as const;

export interface CatalogPluginState {
  userEntry: PluginEntry | null;
  userEntryIsAmbiguous: boolean;
  projectEntries: PluginEntry[];
  registry: RegistryResult | null;
}

export type CatalogPluginPrimaryAction = 'install' | 'update' | 'setup' | 'manage';

type CatalogPluginPresentationStatus =
  | 'not-installed'
  | 'installed'
  | 'installed-version'
  | 'update-available'
  | 'unpinned'
  | 'ambiguous'
  | 'restart-required'
  | 'registry-unavailable'
  | 'provider-unavailable';

interface CatalogPluginPresentationOptions {
  registryUnavailable?: boolean;
  restartRequired?: boolean;
  providerUnavailable?: boolean;
}

interface CatalogPluginPresentation {
  status: CatalogPluginPresentationStatus;
  latestVersion: string | null;
}

export const specMatchesPackage = (spec: string, packageName: string): boolean =>
  spec === packageName || spec.startsWith(`${packageName}@`);

export function getCatalogPluginState(
  entries: PluginEntry[],
  packageName: string,
  registryInfo: Record<string, RegistryResult>,
): CatalogPluginState {
  const matchingEntries = entries.filter((entry) => specMatchesPackage(entry.spec, packageName));
  const userEntries = matchingEntries.filter((entry) => entry.scope === 'user');
  const projectEntries = matchingEntries.filter((entry) => entry.scope === 'project');
  const userEntry = userEntries.length === 1 ? userEntries[0] : null;
  const registry = registryInfo[userEntry?.spec ?? packageName] ?? registryInfo[packageName] ?? null;

  return {
    userEntry,
    userEntryIsAmbiguous: userEntries.length > 1,
    projectEntries,
    registry,
  };
}

export function getLatestNpmSpec(
  packageName: string,
  registry: RegistryResult | null | undefined,
): string | null {
  if (registry?.kind !== 'npm-ok' || registry.name !== packageName || !registry.latestVersion) {
    return null;
  }
  return `${packageName}@${registry.latestVersion}`;
}

export function getCatalogPluginPrimaryAction(
  state: CatalogPluginState,
  packageName: string,
): CatalogPluginPrimaryAction {
  if (state.userEntryIsAmbiguous) {
    return 'manage';
  }

  if (!state.userEntry) {
    return 'install';
  }

  const latestSpec = getLatestNpmSpec(packageName, state.registry);
  return latestSpec && latestSpec !== state.userEntry.spec ? 'update' : 'setup';
}

/**
 * Converts catalog and temporary mutation state into the one compact-card
 * status. Transient states intentionally outrank installed/version metadata.
 */
export function getCatalogPluginPresentation(
  state: CatalogPluginState,
  options: CatalogPluginPresentationOptions = {},
): CatalogPluginPresentation {
  const latestVersion = state.registry?.kind === 'npm-ok'
    ? state.registry.latestVersion
    : null;

  if (state.userEntryIsAmbiguous) {
    return { status: 'ambiguous', latestVersion };
  }
  if (options.restartRequired) {
    return { status: 'restart-required', latestVersion };
  }
  if (options.providerUnavailable) {
    return { status: 'provider-unavailable', latestVersion };
  }
  if (options.registryUnavailable) {
    return { status: 'registry-unavailable', latestVersion };
  }
  if (!state.userEntry) {
    return { status: 'not-installed', latestVersion };
  }
  if (state.registry?.kind === 'npm-ok' && state.registry.currentVersion === state.registry.latestVersion) {
    return { status: 'installed-version', latestVersion };
  }
  if (state.registry?.kind === 'npm-ok' && state.registry.currentVersion === null) {
    return { status: 'unpinned', latestVersion };
  }
  if (state.registry?.kind === 'npm-ok' && latestVersion) {
    return { status: 'update-available', latestVersion };
  }
  return { status: 'installed', latestVersion };
}
