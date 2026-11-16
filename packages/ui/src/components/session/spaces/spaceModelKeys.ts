// The model access choices the create dialog and the grant dialog share: the providers a space can
// be given, whether a choice is complete, and the grant request it becomes.

import React from 'react';

import { SPACE_LOGIN_NAMES, SPACE_LOGIN_ONLY_PROVIDERS, SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import { readSpaceHostLogins, type GrantRequest, type SpaceCustomProvider, type SpaceHostLogin } from '@/lib/spaces/spaces-api';
import { loadSpaceCatalogProviders, loadSpaceCustomProviders, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';

// Where the access comes from: the host's own browser login (7c), the key saved in Settings →
// Providers, an environment variable, or a key typed once.
export type KeySourceChoice = { source: 'login' | 'stored' | 'env' | 'typed'; envName: string; value: string };

/**
 * A provider a dialog offers: with `key`, one a key can be given for, with the API the window
 * forwards it to when the dialog names it (the providers the host knows by name; the host finds
 * any other's in its catalog) and the variable a key usually sits in on the host; without one, a
 * provider that issues no key and is given only through the host's login, GitHub Copilot (7d);
 * with `custom`, one of the user's own from Settings, whose key the host reads from its own
 * configuration, so the row asks for nothing. `storedKey` says whether the host keeps a key for
 * it in Settings → Providers. `blocked` names what keeps a custom provider from a grant, or null.
 */
export type SpaceModelProviderOption = {
  id: string;
  name: string;
  key: { upstream: string | null; envName: string } | null;
  storedKey: boolean;
  custom: { hasKey: boolean; loopback: boolean; blocked: 'unsupported' | null } | null;
};

const customOptionOf = (provider: SpaceCustomProvider): SpaceModelProviderOption => ({
  id: provider.id,
  name: provider.name,
  key: null,
  storedKey: false,
  custom: { hasKey: provider.hasKey, loopback: provider.loopback, blocked: provider.supported ? null : 'unsupported' },
});

/**
 * The providers a space can be given: the host's catalog providers a key can be given for, the
 * composer's first, and then the login-only providers in `loginOnly`, which each dialog names
 * when it has a reason to show the row, the host's login or a grant the space holds. The host
 * lists its catalog for the project the space was made for, `directory`, and says of each whether
 * a key for it can be served and whether it keeps one; until that list arrives, the providers of
 * the composer's own catalog that the host knows by name stand in. The user's own providers come
 * last, from the host's configuration of the same project.
 */
export const useSpaceModelProviders = (directory: string | null | undefined, loginOnly: readonly string[]): SpaceModelProviderOption[] => {
  const activeCatalog = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  // Read again whenever a dialog opens, since the user may have added a provider or a key in Settings meanwhile.
  const custom = useSpacesStore((state) => (directory ? state.customProviders.get(directory) : undefined));
  const hostCatalog = useSpacesStore((state) => (directory ? state.catalogProviders.get(directory) : undefined));
  React.useEffect(() => {
    if (!directory) return;
    void loadSpaceCustomProviders(directory);
    void loadSpaceCatalogProviders(directory);
  }, [directory]);
  const loginOnlyKey = loginOnly.join(' ');
  return React.useMemo(() => {
    const keyOf = (id: string) => {
      const known = SPACE_MODEL_PROVIDERS.find((provider) => provider.id === id);
      return known ? { upstream: known.upstream, envName: known.envName } : { upstream: null, envName: '' };
    };
    const customIds = new Set((custom ?? []).map((provider) => provider.id));
    const keyed: SpaceModelProviderOption[] = hostCatalog
      ? hostCatalog.filter((provider) => provider.supported && !customIds.has(provider.id) && !SPACE_LOGIN_ONLY_PROVIDERS.includes(provider.id)).map((provider) => ({ id: provider.id, name: provider.name, key: keyOf(provider.id), storedKey: provider.storedKey, custom: null }))
      : SPACE_MODEL_PROVIDERS.flatMap(({ id }) => {
        const entry = activeCatalog.find((provider) => provider.id === id);
        return entry ? [{ id, name: entry.name, key: keyOf(id), storedKey: false, custom: null }] : [];
      });
    const loginOnlyOptions: SpaceModelProviderOption[] = loginOnlyKey.split(' ').filter(Boolean).flatMap((id) => {
      const name = SPACE_LOGIN_NAMES.get(id);
      return name ? [{ id, name, key: null, storedKey: false, custom: null }] : [];
    });
    const customOptions = (custom ?? []).map(customOptionOf);
    return [...keyed, ...loginOnlyOptions, ...customOptions].sort((a, b) => Number(b.id === currentProviderId) - Number(a.id === currentProviderId));
  }, [activeCatalog, currentProviderId, custom, hostCatalog, loginOnlyKey]);
};

export const defaultKeySource = (provider: SpaceModelProviderOption, login: HostLoginOffer | null): KeySourceChoice['source'] => {
  if (login || !provider.key) return 'login';
  if (provider.storedKey) return 'stored';
  return provider.key.envName ? 'env' : 'typed';
};

export const isAccessChoiceComplete = (provider: SpaceModelProviderOption, choice: KeySourceChoice): boolean => {
  if (provider.custom) return provider.custom.blocked === null;
  if (choice.source === 'login') return true;
  if (!provider.key) return false;
  if (choice.source === 'stored') return provider.storedKey;
  if (choice.source === 'env') return /^[A-Za-z_][A-Za-z0-9_]*$/.test(choice.envName.trim());
  return choice.value.trim() !== '';
};

export const modelGrantOf = (provider: SpaceModelProviderOption, choice: KeySourceChoice): Extract<GrantRequest, { kind: 'model' | 'login' | 'custom' }> => {
  if (provider.custom) return { kind: 'custom', provider: provider.id };
  if (choice.source === 'login' || !provider.key) return { kind: 'login', provider: provider.id };
  const secret = choice.source === 'stored' ? { kind: 'stored' as const } : choice.source === 'env' ? { kind: 'env' as const, name: choice.envName.trim() } : { kind: 'typed' as const, value: choice.value.trim() };
  return provider.key.upstream ? { kind: 'model', provider: provider.id, upstream: provider.key.upstream, secret } : { kind: 'model', provider: provider.id, secret };
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
