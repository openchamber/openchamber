import {
  activateLinearAuth,
  clearLinearAuth,
  getLinearAuth,
  getLinearAuthWorkspaces,
  getLinearSessionCommentsEnabled,
  setLinearAuth,
  setLinearSessionCommentsEnabled,
  toLinearPublicStatus,
} from './auth.js';
import { fetchLinearIdentity, getValidLinearAccessToken } from './client.js';
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
