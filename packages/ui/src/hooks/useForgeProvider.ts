import { resolveGitProvider, buildGitProviderHosts } from '@/lib/gitProvider';
import type { GitProviderHosts } from '@/lib/gitProvider';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { buildForgeProvider } from '@/lib/forge/adapters';
import type { ForgeProvider } from '@/lib/forge/provider';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { useGitProviderDomainsStore } from '@/stores/useGitProviderDomainsStore';

/**
 * Provider-host sets derived from the connected accounts, the configured api
 * base urls and the user-configured custom domains, mirroring the `hosts` memo
 * inside `useGitProvider` so the imperative resolver classifies directories the
 * same way the hook does.
 */
const buildProviderHosts = (): GitProviderHosts => {
  const gitlabAccounts = useGitLabAuthStore.getState().status?.accounts;
  const giteaAccounts = useGiteaAuthStore.getState().status?.accounts;
  const { domains, apiBaseUrls } = useGitProviderDomainsStore.getState();
  return buildGitProviderHosts({ domains, apiBaseUrls, gitlabAccounts, giteaAccounts });
};

/**
 * Resolve the forge provider for `directory` for non-React code paths.
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
