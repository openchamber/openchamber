import { useMemo } from 'react';
import { resolveGitProvider, useGitProvider } from '@/lib/gitProvider';
import type { GitProviderHosts } from '@/lib/gitProvider';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { buildForgeProvider } from '@/lib/forge/adapters';
import type { ForgeProvider } from '@/lib/forge/provider';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { useGitProviderDomainsStore } from '@/stores/useGitProviderDomainsStore';

/**
 * Provider-host sets derived from the connected accounts and the
 * user-configured custom domains, mirroring the `hosts` memo inside
 * `useGitProvider` so the imperative resolver classifies directories the same
 * way the hook does.
 */
const buildProviderHosts = (): GitProviderHosts => {
  const gitlabAccounts = useGitLabAuthStore.getState().status?.accounts;
  const giteaAccounts = useGiteaAuthStore.getState().status?.accounts;
  const domains = useGitProviderDomainsStore.getState().domains;
  return {
    github: domains.github,
    gitlab: [...(gitlabAccounts ?? []).map((account) => account.baseUrl), ...domains.gitlab],
    gitea: [...(giteaAccounts ?? []).map((account) => account.baseUrl), ...domains.gitea],
  };
};

/**
 * Resolve the forge provider for `directory` reactively: the provider kind is
 * detected from the directory's remotes via `useGitProvider`, and the provider
 * adapters are built from the registered runtime APIs. Returns null for 'other'
 * providers (no forge-backed UI) and for kinds whose runtime API is missing.
 */
export const useForgeProvider = (directory: string | null | undefined): ForgeProvider | null => {
  const kind = useGitProvider(directory);
  const runtimeApis = useRuntimeAPIs();
  const apis = useMemo(
    () => ({ github: runtimeApis.github, gitlab: runtimeApis.gitlab, gitea: runtimeApis.gitea }),
    [runtimeApis.github, runtimeApis.gitlab, runtimeApis.gitea],
  );
  return useMemo(
    () => (kind && kind !== 'other' ? buildForgeProvider(kind, apis) : null),
    [kind, apis],
  );
};

/**
 * Imperative counterpart of `useForgeProvider` for non-React code paths.
 * Resolves the directory's provider from the auth stores' connected accounts
 * and the runtime's registered APIs in one async step.
 */
export const getForgeProviderForDirectory = async (directory: string): Promise<ForgeProvider | null> => {
  const hosts = buildProviderHosts();
  const kind = await resolveGitProvider(directory, hosts);
  if (!kind || kind === 'other') return null;
  const apis = getRegisteredRuntimeAPIs();
  if (!apis) return null;
  return buildForgeProvider(kind, {
    github: apis.github,
    gitlab: apis.gitlab,
    gitea: apis.gitea,
  });
};
