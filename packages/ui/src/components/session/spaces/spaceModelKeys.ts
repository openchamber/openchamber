// The model key choices the create dialog and the grant dialog share: the providers a space can be
// given a key for, whether a choice is complete, and the grant request it becomes.

import React from 'react';

import { SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import type { GrantRequest } from '@/lib/spaces/spaces-api';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';

export type KeySourceChoice = { source: 'env' | 'typed'; envName: string; value: string };

type SpaceModelProviderOption = (typeof SPACE_MODEL_PROVIDERS)[number] & { name: string };

/**
 * The providers of the host's catalog a space can be given a key for; the composer's comes first.
 * Read for the host project the space was made for: inside a space the composer's own list holds
 * only the providers the space already has models of, and the grant dialog is where more are given.
 * A project whose catalog was not read yet is read now; until then the active one stands in.
 */
export const useSpaceModelProviders = (projectDirectory?: string | null): SpaceModelProviderOption[] => {
  const projectCatalog = useConfigStore((state) => (projectDirectory ? selectProvidersForDirectory(state, projectDirectory) : state.providers));
  const activeCatalog = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const missing = Boolean(projectDirectory) && projectCatalog.length === 0;
  React.useEffect(() => {
    if (missing) void useConfigStore.getState().loadProviders({ directory: projectDirectory, source: 'spaceAccess' });
  }, [missing, projectDirectory]);
  const catalog = missing ? activeCatalog : projectCatalog;
  return React.useMemo(() => SPACE_MODEL_PROVIDERS
    .flatMap((known) => {
      const entry = catalog.find((provider) => provider.id === known.id);
      return entry ? [{ ...known, name: entry.name }] : [];
    })
    .sort((a, b) => Number(b.id === currentProviderId) - Number(a.id === currentProviderId)), [catalog, currentProviderId]);
};

export const isKeySourceComplete = (choice: KeySourceChoice): boolean => (choice.source === 'env'
  ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(choice.envName.trim())
  : choice.value.trim() !== '');

export const modelGrantOf = (provider: { id: string; upstream: string }, choice: KeySourceChoice): Extract<GrantRequest, { kind: 'model' }> => ({
  kind: 'model',
  provider: provider.id,
  upstream: provider.upstream,
  secret: choice.source === 'env' ? { kind: 'env', name: choice.envName.trim() } : { kind: 'typed', value: choice.value.trim() },
});

