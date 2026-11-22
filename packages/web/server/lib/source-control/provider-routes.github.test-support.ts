import os from 'node:os';
import path from 'node:path';
import { githubDescriptor } from '../github/descriptor.js';
import { createSourceControlAuthStore } from './auth-storage.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerProviderRoutes } from './provider-routes.js';
import type { Application } from '../shared/http-contracts.js';
import type { GitHubProviderOptions } from '../github/provider.js';
import type { AccountEvents } from './provider-contract.js';
import type { AccountEventPayloads } from './provider-registry.js';
import type { ProviderRouteOptions } from './provider-routes.js';

export interface GitHubRoutesOptions extends GitHubProviderOptions {
  validateReadContext?: ProviderRouteOptions['validateReadContext'];
  validateMutationContext?: ProviderRouteOptions['validateMutationContext'];
  mutationExecutor?: ProviderRouteOptions['mutationExecutor'];
  oauthFlowRegistry?: ProviderRouteOptions['oauthFlowRegistry'];
  onAccountConnected?: AccountEvents['connected'];
  onAccountInvalidated?: (identity: AccountEventPayloads['invalidated']) => Promise<void>;
  onAccountRemoved?: AccountEvents['removed'];
}
export function registerGitHubRoutes(app: Application, options: GitHubRoutesOptions = {}) {
  const providers = createSourceControlProviders({
    authStore: createSourceControlAuthStore({ filePath: path.join(os.tmpdir(), 'openchamber-github-route-tests', 'source-control-auth.json') }),
    descriptors: createProviderDescriptors([githubDescriptor]),
    hostServices: { github: options },
  });
  providers.events.subscribe({
    connected: (payload: Parameters<AccountEvents['connected']>[0]) => options.onAccountConnected?.(payload),
    invalidated: (identity) => options.onAccountInvalidated?.(identity),
    removed: (identity: Parameters<AccountEvents['removed']>[0]) => options.onAccountRemoved?.(identity),
  });
  const shell = registerProviderRoutes(app, {
    providers,
    validateReadContext: options.validateReadContext,
    validateMutationContext: options.validateMutationContext,
    mutationExecutor: options.mutationExecutor,
    oauthFlowRegistry: options.oauthFlowRegistry,
  });
  return {
    readCurrentAccountId: async (instance: string) => {
      const provider = await providers.implementation('github');
      if (!provider) throw new TypeError('GitHub provider is unavailable');
      return provider.auth.readCurrentAccountId({ instance });
    },
    readChangeRequestHead: shell.readChangeRequestHead,
    resolveChangeRequestSource: shell.resolveChangeRequestSource,
    readLiveSummaries: shell.readLiveSummaries,
  };
}
