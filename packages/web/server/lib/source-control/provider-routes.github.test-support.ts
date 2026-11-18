import { githubDescriptor } from '../github/descriptor.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerProviderRoutes } from './provider-routes.js';
import type { Application } from '../shared/http-contracts.js';
import type { GitHubProviderOptions } from '../github/provider.js';
import type { AccountEvents } from './provider-contract.js';
import type { createBindingService } from './binding-service.js';
import type { createMutationExecutor } from './mutation-executor.js';
import type { createOAuthFlowRegistry } from './oauth-flow-registry.js';

export interface GitHubRoutesOptions extends GitHubProviderOptions {
  validateReadContext?: ReturnType<typeof createBindingService>['validateReadContext'];
  validateMutationContext?: ReturnType<typeof createBindingService>['validateMutationContext'];
  mutationExecutor?: ReturnType<typeof createMutationExecutor>;
  oauthFlowRegistry?: ReturnType<typeof createOAuthFlowRegistry>;
  onAccountConnected?: AccountEvents['connected'];
  onAccountInvalidated?: AccountEvents['invalidated'];
  onAccountRemoved?: AccountEvents['removed'];
}
export function registerGitHubRoutes(app: Application, options: GitHubRoutesOptions = {}) {
  const providers = createSourceControlProviders({
    descriptors: createProviderDescriptors([githubDescriptor]),
    hostServices: { github: options },
  });
  providers.events.subscribe({
    connected: (payload: Parameters<AccountEvents['connected']>[0]) => options.onAccountConnected?.(payload),
    invalidated: (identity: Parameters<AccountEvents['invalidated']>[0]) => options.onAccountInvalidated?.(identity),
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
    readCurrentAccountId: async (instance: string) => (await providers.implementation('github')).auth.readCurrentAccountId({ instance }),
    readChangeRequestHead: shell.readChangeRequestHead,
    resolveChangeRequestSource: shell.resolveChangeRequestSource,
    readLiveSummaries: shell.readLiveSummaries,
  };
}
