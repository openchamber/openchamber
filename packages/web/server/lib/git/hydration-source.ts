import type { NetworkOperationsOptions, RepositoryAuthority } from './network-execution-contracts.js';

interface HydrationSourceInput {
  directory: string;
  parentRemoteName: string;
  repositoryAuthority: RepositoryAuthority;
  validateGitTransportContext: NonNullable<NetworkOperationsOptions['validateGitTransportContext']>;
  readConfiguredUrl(): Promise<string>;
  inspect(endpoint: string): Promise<{ sourceRequired: boolean; requirements: readonly unknown[] }>;
}

export const resolveHydrationSource = async ({
  directory, parentRemoteName, repositoryAuthority, validateGitTransportContext, readConfiguredUrl, inspect,
}: HydrationSourceInput) => {
  try {
    return (await validateGitTransportContext({
      directory, ...repositoryAuthority, remote: parentRemoteName, endpointKind: 'fetch',
    })).endpoint;
  } catch (error) {
    const configured = (await readConfiguredUrl()).trim();
    const { sourceRequired, requirements } = await inspect(configured);
    if (sourceRequired || requirements.length > 0) throw error;
    return configured;
  }
};
