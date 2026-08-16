import { describe, expect, test } from 'bun:test';
import type { PluginEntry, RegistryResult } from '@/stores/usePluginsStore';
import * as thirdPartyCatalog from './thirdPartyPlugins';
import {
  getCatalogPluginState,
  getCatalogPluginPrimaryAction,
  getLatestNpmSpec,
  specMatchesPackage,
} from './thirdPartyPlugins';

type CatalogPresentationStatus =
  | 'not-installed'
  | 'installed'
  | 'installed-version'
  | 'update-available'
  | 'unpinned'
  | 'ambiguous'
  | 'restart-required'
  | 'registry-unavailable'
  | 'provider-unavailable';

type GetCatalogPluginPresentation = (
  state: ReturnType<typeof getCatalogPluginState>,
  options?: {
    registryUnavailable?: boolean;
    restartRequired?: boolean;
    providerUnavailable?: boolean;
  },
) => {
  status: CatalogPresentationStatus;
  latestVersion: string | null;
};

const getCatalogPluginPresentation = (
  thirdPartyCatalog as unknown as {
    getCatalogPluginPresentation?: GetCatalogPluginPresentation;
  }
).getCatalogPluginPresentation;

const claudePackage = '@openchamber/opencode-claude';

const entry = (spec: string, scope: PluginEntry['scope'] = 'user'): PluginEntry => ({
  id: `config:${scope}:${spec}`,
  spec,
  scope,
  kind: 'config',
  parsedKind: 'npm',
});

const registry = (spec: string, currentVersion: string | null, latestVersion = '0.7.0'): RegistryResult => ({
  kind: 'npm-ok',
  spec,
  name: claudePackage,
  currentVersion,
  latestVersion,
  versions: ['0.6.0', latestVersion],
  hasUpdate: currentVersion !== null && currentVersion !== latestVersion,
});

describe('third-party plugin catalog helpers', () => {
  test('derives compact-card status with explicit transient-state priority', () => {
    expect(typeof getCatalogPluginPresentation).toBe('function');
    if (!getCatalogPluginPresentation) return;

    const notInstalled = getCatalogPluginState([], claudePackage, {});
    expect(getCatalogPluginPresentation(notInstalled)).toEqual({
      status: 'not-installed',
      latestVersion: null,
    });

    const current = getCatalogPluginState(
      [entry(`${claudePackage}@0.7.0`)],
      claudePackage,
      { [`${claudePackage}@0.7.0`]: registry(`${claudePackage}@0.7.0`, '0.7.0') },
    );
    expect(getCatalogPluginPresentation(current)).toEqual({
      status: 'installed-version',
      latestVersion: '0.7.0',
    });

    const outdated = getCatalogPluginState(
      [entry(`${claudePackage}@0.6.0`)],
      claudePackage,
      { [`${claudePackage}@0.6.0`]: registry(`${claudePackage}@0.6.0`, '0.6.0') },
    );
    expect(getCatalogPluginPresentation(outdated)).toEqual({
      status: 'update-available',
      latestVersion: '0.7.0',
    });
    expect(getCatalogPluginPresentation(outdated, { registryUnavailable: true })).toEqual({
      status: 'registry-unavailable',
      latestVersion: '0.7.0',
    });
    expect(getCatalogPluginPresentation(outdated, { providerUnavailable: true })).toEqual({
      status: 'provider-unavailable',
      latestVersion: '0.7.0',
    });
    expect(getCatalogPluginPresentation(outdated, {
      providerUnavailable: true,
      restartRequired: true,
    })).toEqual({
      status: 'restart-required',
      latestVersion: '0.7.0',
    });

    const ambiguous = getCatalogPluginState(
      [entry(claudePackage), entry(`${claudePackage}@0.6.0`)],
      claudePackage,
      {},
    );
    expect(getCatalogPluginPresentation(ambiguous)).toEqual({
      status: 'ambiguous',
      latestVersion: null,
    });
  });

  test('matches only a package or its versioned spec', () => {
    expect(specMatchesPackage(claudePackage, claudePackage)).toBe(true);
    expect(specMatchesPackage(`${claudePackage}@0.6.0`, claudePackage)).toBe(true);
    expect(specMatchesPackage('@openchamber/opencode-claude-extra@0.6.0', claudePackage)).toBe(false);
  });

  test('points catalog plugins at the OpenChamber GitHub and npm packages', () => {
    expect(thirdPartyCatalog.THIRD_PARTY_PLUGINS.map((plugin) => ({
      id: plugin.id,
      packageName: plugin.packageName,
      homepage: plugin.homepage,
    }))).toEqual([
      {
        id: 'opencode-claude',
        packageName: '@openchamber/opencode-claude',
        homepage: 'https://github.com/openchamber/opencode-claude',
      },
      {
        id: 'opencode-commandcode',
        packageName: '@openchamber/opencode-commandcode',
        homepage: 'https://github.com/openchamber/opencode-commandcode',
      },
      {
        id: 'opencode-cursor-oauth',
        packageName: '@openchamber/opencode-cursor',
        homepage: 'https://github.com/openchamber/opencode-cursor',
      },
    ]);
  });

  test('uses the configured user entry and its registry result', () => {
    const installed = entry(`${claudePackage}@0.6.0`);
    const state = getCatalogPluginState(
      [installed],
      claudePackage,
      { [installed.spec]: registry(installed.spec, '0.6.0') },
    );

    expect(state.userEntry).toEqual(installed);
    expect(state.userEntryIsAmbiguous).toBe(false);
    expect(state.projectEntries).toEqual([]);
    expect(state.registry).toEqual(registry(installed.spec, '0.6.0'));
  });

  test('does not choose an entry when multiple user specs would make a mutation ambiguous', () => {
    const state = getCatalogPluginState(
      [entry(claudePackage), entry(`${claudePackage}@0.6.0`), entry(claudePackage, 'project')],
      claudePackage,
      {},
    );

    expect(state.userEntry).toBeNull();
    expect(state.userEntryIsAmbiguous).toBe(true);
    expect(state.projectEntries).toHaveLength(1);
  });

  test('returns an exact latest spec only from a valid npm registry result', () => {
    expect(getLatestNpmSpec(claudePackage, registry(claudePackage, null))).toBe(`${claudePackage}@0.7.0`);
    expect(getLatestNpmSpec(claudePackage, {
      kind: 'npm-network',
      spec: claudePackage,
      error: 'offline',
    })).toBeNull();
  });

  test('chooses an update for a bare or outdated user-wide entry', () => {
    const bare = getCatalogPluginState(
      [entry(claudePackage)],
      claudePackage,
      { [claudePackage]: registry(claudePackage, null) },
    );
    const outdated = getCatalogPluginState(
      [entry(`${claudePackage}@0.6.0`)],
      claudePackage,
      { [`${claudePackage}@0.6.0`]: registry(`${claudePackage}@0.6.0`, '0.6.0') },
    );

    expect(getCatalogPluginPrimaryAction(bare, claudePackage)).toBe('update');
    expect(getCatalogPluginPrimaryAction(outdated, claudePackage)).toBe('update');
  });

  test('keeps setup as the primary action once the exact latest spec is installed', () => {
    const installed = entry(`${claudePackage}@0.7.0`);
    const state = getCatalogPluginState(
      [installed],
      claudePackage,
      { [installed.spec]: registry(installed.spec, '0.7.0') },
    );

    expect(getCatalogPluginPrimaryAction(state, claudePackage)).toBe('setup');
  });

  test('sends ambiguous entries to manual plugin management', () => {
    const state = getCatalogPluginState(
      [entry(claudePackage), entry(`${claudePackage}@0.6.0`)],
      claudePackage,
      {},
    );

    expect(getCatalogPluginPrimaryAction(state, claudePackage)).toBe('manage');
  });
});
