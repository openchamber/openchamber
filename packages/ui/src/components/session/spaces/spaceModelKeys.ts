// The model access choices the create dialog and the grant dialog share: the providers a space can
// be given, whether a choice is complete, and the grant request it becomes.

import React from 'react';

import { SPACE_LOGIN_NAMES, SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import { readSpaceHostLogins, type GrantRequest, type SpaceHostLogin } from '@/lib/spaces/spaces-api';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';

// Where the access comes from: the host's own browser login (7c), an environment variable, or a
// key typed once.
export type KeySourceChoice = { source: 'login' | 'env' | 'typed'; envName: string; value: string };

/**
 * A provider a dialog offers: with `key`, the API the window forwards a key to and the variable a
 * key usually sits in on the host; without one, a provider that issues no key and is given only
 * through the host's login, GitHub Copilot (7d).
 */
export type SpaceModelProviderOption = { id: string; name: string; key: { upstream: string; envName: string } | null };

/**
 * The providers a space can be given: those of the host's catalog a key can be given for, the
 * composer's first, and then the login-only providers in `loginOnly`, which each dialog names
 * when it has a reason to show the row, the host's login or a grant the space holds. The catalog
 * is read for the host project the space was made for: inside a space the composer's own list
 * holds only the providers the space already has models of, and the grant dialog is where more
 * are given. A project whose catalog was not read yet is read now; until then the active one
 * stands in.
 */
export const useSpaceModelProviders = (projectDirectory: string | null | undefined, loginOnly: readonly string[]): SpaceModelProviderOption[] => {
  const projectCatalog = useConfigStore((state) => (projectDirectory ? selectProvidersForDirectory(state, projectDirectory) : state.providers));
  const activeCatalog = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const missing = Boolean(projectDirectory) && projectCatalog.length === 0;
  React.useEffect(() => {
    if (missing) void useConfigStore.getState().loadProviders({ directory: projectDirectory, source: 'spaceAccess' });
  }, [missing, projectDirectory]);
  const catalog = missing ? activeCatalog : projectCatalog;
  const loginOnlyKey = loginOnly.join(' ');
  return React.useMemo(() => {
    const keyed: SpaceModelProviderOption[] = SPACE_MODEL_PROVIDERS.flatMap(({ id, upstream, envName }) => {
      const entry = catalog.find((provider) => provider.id === id);
      return entry ? [{ id, name: entry.name, key: { upstream, envName } }] : [];
    });
    const loginOnlyOptions: SpaceModelProviderOption[] = loginOnlyKey.split(' ').filter(Boolean).flatMap((id) => {
      const name = SPACE_LOGIN_NAMES.get(id);
      return name ? [{ id, name, key: null }] : [];
    });
    return [...keyed, ...loginOnlyOptions].sort((a, b) => Number(b.id === currentProviderId) - Number(a.id === currentProviderId));
  }, [catalog, currentProviderId, loginOnlyKey]);
};

export const isAccessChoiceComplete = (provider: SpaceModelProviderOption, choice: KeySourceChoice): boolean => {
  if (choice.source === 'login') return true;
  if (!provider.key) return false;
  if (choice.source === 'env') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(choice.envName.trim());
  return choice.value.trim() !== '';
};

export const modelGrantOf = (provider: SpaceModelProviderOption, choice: KeySourceChoice): Extract<GrantRequest, { kind: 'model' | 'login' }> => {
  if (choice.source === 'login' || !provider.key) return { kind: 'login', provider: provider.id };
  return {
    kind: 'model',
    provider: provider.id,
    upstream: provider.key.upstream,
    secret: choice.source === 'env' ? { kind: 'env', name: choice.envName.trim() } : { kind: 'typed', value: choice.value.trim() },
  };
};

/**
 * The host's browser login for a provider as the dialogs show it: what it is called, its state,
 * and when its token ends, null for one that has no end and so needs the stronger warning.
 */
export type HostLoginOffer = { name: string; state: SpaceHostLogin['state']; expires: string | null };

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
        return name ? [[login.provider, { name, state: login.state, expires: login.expires }]] : [];
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
