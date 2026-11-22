import {
  LinearAuthError,
  getLinearStorageState,
  getLinearAuthByWorkspaceId,
  activateLinearAuth,
  clearLinearAuth,
  getLinearAuth,
  getLinearAuthWorkspaces,
  getLinearSessionCommentsEnabled,
  setLinearAuth,
  setLinearSessionCommentsEnabled,
  configureLinearVaultReader,
  readLinearVaultToken,
  toLinearPublicStatus,
} from './auth.js';
import { fetchLinearIdentity, getValidLinearAccessToken, getValidLinearAuthorization } from './client.js';
import {
  getLinearIssue,
  getLinearIssueSummaries,
  listLinearIssueStates,
  listLinearIssues,
  updateLinearIssue,
} from './issues.js';
import {
  LinearMappingError,
  mergeLinearMappingView,
  readStoredLinearMapping,
  setStoredLinearMapping,
} from './mapping.js';
import {
  completeAuthorizationBroker,
  consumeAuthorizationCallback,
  pollAuthorizationBroker,
  revokeToken,
  startAuthorization,
} from './oauth.js';
import { LinearSessionStatusError, postLinearSessionStatus } from './status.js';
import { listLinearTeams } from './teams.js';

export const linearLibraries = Object.freeze({
  LinearAuthError,
  getLinearStorageState,
  getLinearAuthByWorkspaceId,
  readLinearVaultToken,
  activateLinearAuth,
  clearLinearAuth,
  getLinearAuth,
  getLinearAuthWorkspaces,
  getLinearSessionCommentsEnabled,
  setLinearAuth,
  setLinearSessionCommentsEnabled,
  toLinearPublicStatus,
  fetchLinearIdentity,
  getValidLinearAccessToken,
  getValidLinearAuthorization,
  getLinearIssue,
  getLinearIssueSummaries,
  listLinearIssueStates,
  listLinearIssues,
  updateLinearIssue,
  LinearMappingError,
  mergeLinearMappingView,
  readStoredLinearMapping,
  setStoredLinearMapping,
  completeAuthorizationBroker,
  consumeAuthorizationCallback,
  pollAuthorizationBroker,
  revokeToken,
  startAuthorization,
  LinearSessionStatusError,
  postLinearSessionStatus,
  listLinearTeams,
});

export {
  LinearAuthError,
  getLinearStorageState,
  getLinearAuth,
  getLinearAuthByWorkspaceId,
  getLinearAuthWorkspaces,
  setLinearAuth,
  clearLinearAuth,
  activateLinearAuth,
  configureLinearVaultReader,
  readLinearVaultToken,
  getValidLinearAccessToken,
  getValidLinearAuthorization,
};
