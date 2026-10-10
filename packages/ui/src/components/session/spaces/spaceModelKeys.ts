// The model key choices the create dialog and the grant dialog share: the providers a space can be
// given a key for, whether a choice is complete, and the grant request it becomes.

import React from 'react';

import { SPACE_LOGIN_NAMES, SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import { readSpaceHostLogins, type GrantRequest, type SpaceHostLogin } from '@/lib/spaces/spaces-api';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';

// Where the access comes from: the host's own browser login (7c), an environment variable, or a
// key typed once.
export type KeySourceChoice = { source: 'login' | 'env' | 'typed'; envName: string; value: string };

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

export const isKeySourceComplete = (choice: KeySourceChoice): boolean => {
  if (choice.source === 'login') return true;
  if (choice.source === 'env') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(choice.envName.trim());
  return choice.value.trim() !== '';
};

export const modelGrantOf = (provider: { id: string; upstream: string }, choice: KeySourceChoice): Extract<GrantRequest, { kind: 'model' | 'login' }> => {
  if (choice.source === 'login') return { kind: 'login', provider: provider.id };
  return {
    kind: 'model',
    provider: provider.id,
    upstream: provider.upstream,
    secret: choice.source === 'env' ? { kind: 'env', name: choice.envName.trim() } : { kind: 'typed', value: choice.value.trim() },
  };
};

/** The host's browser login for a provider as the dialogs show it: what it is called, and its state. */
export type HostLoginOffer = { name: string; state: SpaceHostLogin['state'] };

/**
 * The host's browser logins by provider, read once when a dialog opens and again on `refresh`,
 * after a grant the host refused. Null until read, and null when the host could not be asked:
 * the dialogs then offer no login, and never say "signed out" on a failed read.
 */
export const useSpaceHostLogins = (open: boolean) => {
  const [logins, setLogins] = React.useState<ReadonlyMap<string, HostLoginOffer> | null>(null);
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    readSpaceHostLogins(controller.signal).then(
      (answer) => setLogins(new Map(answer.flatMap((login) => {
        const name = SPACE_LOGIN_NAMES.get(login.provider);
        return name ? [[login.provider, { name, state: login.state }]] : [];
      }))),
      () => { if (!controller.signal.aborted) setLogins(null); },
    );
    return () => controller.abort();
  }, [generation, open]);
  return { logins, refresh: React.useCallback(() => setGeneration((value) => value + 1), []) };
};

/** The host's login a dialog offers for a provider: one the host can say now, or none. */
export const usableHostLoginOf = (logins: ReadonlyMap<string, HostLoginOffer> | null, providerId: string): HostLoginOffer | null => {
  const login = logins?.get(providerId);
  return login?.state === 'usable' ? login : null;
};

