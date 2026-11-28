import { OpenCode } from '@opencode/client';
import type { CredentialEntry, ProviderInfo } from '@opencode/client';
import type { ServiceProviderAccountActivation, ServiceProviderAccountActivationResult, ServiceProviderAccounts } from '@openchamber/sdk';
import { z } from 'zod';

import { LOCATION_PLUGINS_NOT_READY, waitForPluginList } from '../opencode/location-plugins.js';

type ProviderAccountsConnection = {
  buildOpenCodeUrl: (path: string, prefix?: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
  getDefaultDirectory: () => Promise<string | null>;
  getManagedLimitFailover: () => { noteAccountSwitch: (accountId: string) => void } | null;
};

type ActivateFailoverAccount = (accountId: string, expectedActiveAccountId: string | undefined) => Promise<'activated' | 'stale' | 'missing'>;

export class ProviderAccountsError extends Error {}

const integrationId = (provider: ProviderInfo) => provider.integrationID ?? provider.id;
const planLabel = z.string().trim().min(1);

const accountGroups = (providers: ProviderInfo[], credentials: CredentialEntry[]): ServiceProviderAccounts[] => {
  const byIntegration = new Map<string, ServiceProviderAccounts['accounts']>();
  for (const { id, integrationID, label, active, value } of credentials) {
    const accounts = byIntegration.get(integrationID) ?? [];
    accounts.push({ id, label, active, plan: planLabel.safeParse(value.metadata?.plan).data ?? null });
    byIntegration.set(integrationID, accounts);
  }
  return providers.flatMap((provider) => {
    const accounts = byIntegration.get(integrationId(provider));
    return accounts?.length ? [{ id: provider.id, name: provider.name, accounts }] : [];
  });
};

export const createProviderAccounts = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, getDefaultDirectory, getManagedLimitFailover }: ProviderAccountsConnection) => {
  const baseUrl = () => buildOpenCodeUrl('', '').replace(/\/+$/, '');
  const connection = (callerSignal?: AbortSignal) => {
    const base = baseUrl();
    const headers = getOpenCodeAuthHeaders();
    const timeout = AbortSignal.timeout(10_000);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    const client = OpenCode.make({ baseUrl: base, headers });
    const check = () => {
      signal.throwIfAborted();
      if (baseUrl() !== base) throw new ProviderAccountsError('The selected OpenCode changed');
    };
    const providers = async () => {
      const directory = await getDefaultDirectory();
      check();
      if (!directory) throw new ProviderAccountsError('No OpenCode directory is available');
      const scoped = OpenCode.make({ baseUrl: base, headers: { ...headers, 'x-opencode-directory': encodeURIComponent(directory) } });
      let probeError: unknown;
      const ready = await waitForPluginList(async (bounded) => {
        try {
          return (await scoped.plugin.list(undefined, { signal: bounded })).data;
        } catch (error) {
          probeError = bounded.aborted ? new ProviderAccountsError('Location plugin readiness timed out') : error;
          throw error;
        }
      }, signal);
      if (!ready) throw probeError ?? new ProviderAccountsError(LOCATION_PLUGINS_NOT_READY);
      check();
      return (await scoped.provider.list(undefined, { signal })).data;
    };
    return { credential: client.credential, providers, check, signal };
  };

  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <Result>(run: () => Promise<Result>) => {
    const result = tail.then(run);
    tail = result.catch(() => undefined);
    return result;
  };

  const list = async () => {
    const { credential, providers, check, signal } = connection();
    const available = await providers();
    const stored = await credential.list({ signal });
    check();
    return accountGroups(available, stored);
  };

  const activate = async (
    { providerId, accountId, expectedActiveAccountId }: ServiceProviderAccountActivation,
    mayActivate: () => Promise<boolean>,
  ): Promise<ServiceProviderAccountActivationResult | 'missing' | 'refused'> => {
    const { credential, providers, check, signal } = connection();
    const provider = (await providers()).find(({ id }) => id === providerId);
    if (!provider) return 'missing';
    return serialize(async () => {
      check();
      const read = async () => accountGroups([provider], await credential.list({ signal }))[0];
      const before = await read();
      if (!await mayActivate()) return 'refused';
      check();
      if (!before?.accounts.some(({ id }) => id === accountId)) return 'missing';
      const active = before.accounts.find((account) => account.active)?.id;
      if (expectedActiveAccountId !== undefined && active !== expectedActiveAccountId) {
        return { status: 'stale', provider: before };
      }
      if (active === accountId) return { status: 'activated', provider: before };
      await credential.activate({ credentialID: accountId }, { signal });
      const after = await read();
      check();
      if (!after?.accounts.some(({ id, active: selected }) => id === accountId && selected)) {
        throw new ProviderAccountsError('OpenCode did not confirm the account switch');
      }
      getManagedLimitFailover()?.noteAccountSwitch(accountId);
      return { status: 'activated', provider: after };
    });
  };

  const withManagedAccounts = <Result>(callerSignal: AbortSignal, run: (activate: ActivateFailoverAccount) => Promise<Result>) => {
    const { credential, check, signal } = connection(callerSignal);
    const activate: ActivateFailoverAccount = async (accountId, expectedActiveAccountId) => {
      check();
      if (!getManagedLimitFailover()) return 'missing';
      const accounts = await credential.list({ signal });
      check();
      const target = accounts.find(({ id }) => id === accountId);
      if (!target) return 'missing';
      const active = accounts.find(({ integrationID, active }) => integrationID === target.integrationID && active)?.id;
      if (active !== expectedActiveAccountId) return 'stale';
      if (!getManagedLimitFailover()) return 'missing';
      await credential.activate({ credentialID: accountId }, { signal });
      const confirmed = (await credential.list({ signal })).some(({ id, active }) => id === accountId && active);
      check();
      if (!getManagedLimitFailover() || !confirmed) return 'missing';
      return 'activated';
    };
    return serialize(() => {
      check();
      return run(activate);
    });
  };

  return { list, activate, withManagedAccounts };
};
