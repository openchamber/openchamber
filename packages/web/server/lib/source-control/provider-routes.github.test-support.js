import { githubDescriptor } from '../github/descriptor.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createSourceControlProviders } from './provider-registry.js';
import { registerProviderRoutes } from './provider-routes.js';

/**
 * GitHub served by the shared route shell, with the options its own routes
 * used to take: the provider's construction services and test seams
 * (`resolveGitHubRepoFromDirectory`, `resolveRepoNetwork`,
 * `resolveGitHubPrStatus`, `readContributorProvenance`, `fetch`,
 * `timeoutMs`), the binding service's validators, the mutation executor, the
 * OAuth flow registry and the account callbacks. The returned object answers
 * what other modules ask of GitHub, as the routes module did.
 */
export function registerGitHubRoutes(app, options = {}) {
  const providers = createSourceControlProviders({
    descriptors: createProviderDescriptors([githubDescriptor]),
    hostServices: { github: options },
  });
  providers.events.subscribe({
    connected: (payload) => options.onAccountConnected?.(payload),
    invalidated: (identity) => options.onAccountInvalidated?.(identity),
    removed: (identity) => options.onAccountRemoved?.(identity),
  });
  const shell = registerProviderRoutes(app, {
    providers,
    validateReadContext: options.validateReadContext,
    validateMutationContext: options.validateMutationContext,
    mutationExecutor: options.mutationExecutor,
    oauthFlowRegistry: options.oauthFlowRegistry,
  });
  return {
    readCurrentAccountId: async (instance) => (await providers.implementation('github')).auth.readCurrentAccountId({ instance }),
    readChangeRequestHead: shell.readChangeRequestHead,
    resolveChangeRequestSource: shell.resolveChangeRequestSource,
    readLiveSummaries: shell.readLiveSummaries,
  };
}
