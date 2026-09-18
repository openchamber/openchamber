import type {
  SourceControlAPI,
  SourceControlAuthStatus,
  SourceControlCapabilities,
  SourceControlIdentity,
} from '@openchamber/ui/lib/api/types';
import { readRepositoryContext, readSystemRepositoryBinding } from './git-remotes';

export const VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE = 'Source control providers are not supported in the VS Code runtime';
const GITHUB_IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };

const unsupported = async (): Promise<never> => {
  throw new Error(VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE);
};

/**
 * VS Code manages Git hosting providers itself. The shared UI still reads a
 * repository context and binding before Git network operations, so those come
 * from the repository's remotes as a ready System-transport binding. Every
 * provider operation stays unsupported and never reaches the OpenCode proxy.
 */
export const createVSCodeSourceControlAPI = (): SourceControlAPI => ({
  repositoryContext: readRepositoryContext,
  repositoryBinding: readSystemRepositoryBinding,
  resetRepositoryBinding: (intent) => readSystemRepositoryBinding(intent.directory),
  repositoryProviderBindingMutate: unsupported,
  // The known identity lets shared auth consumers settle on an explicit checked state.
  authInstances: async () => [GITHUB_IDENTITY],
  capabilities: async (identity: SourceControlIdentity): Promise<SourceControlCapabilities> => ({
    identity,
    authentication: false,
    authenticationMethods: {
      device: { available: false, reason: 'runtime-unsupported' },
      pat: { available: false, reason: 'runtime-unsupported' },
      cli: { available: false, reason: 'runtime-unsupported' },
    },
    multipleAccounts: false,
    projects: false,
    issues: false,
    changeRequests: false,
    draftChangeRequests: false,
    mergeChangeRequests: false,
    ci: false,
  }),
  authStatus: async (identity: SourceControlIdentity): Promise<SourceControlAuthStatus> => ({
    ...identity,
    status: 'unsupported',
    connected: false,
    reason: 'no-supported-auth-method',
    message: VSCODE_SOURCE_CONTROL_UNSUPPORTED_MESSAGE,
  }),
  authStart: unsupported,
  authComplete: unsupported,
  authSetToken: unsupported,
  authDisconnect: unsupported,
  authActivate: unsupported,
  authSetCliDisabled: unsupported,
  changeRequestStatus: unsupported,
  changeRequestCreate: unsupported,
  changeRequestUpdate: unsupported,
  changeRequestMerge: unsupported,
  changeRequestReady: unsupported,
  changeRequestsList: unsupported,
  changeRequestContext: unsupported,
  issuesList: unsupported,
  issueGet: unsupported,
  issueComments: unsupported,
  projectUpstream: unsupported,
  projectBranches: unsupported,
});
