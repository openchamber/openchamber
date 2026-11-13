// What the legacy `/api/linear/*` routes (`routes.js`), the tracker adapter
// (`tracker.js`) and the shared auth steps (`auth-status.js`) take from
// Linear's libraries, as one object. Callers load this module lazily, so
// Linear's libraries stay out of server startup; one named export keeps the
// lazy boundary visible to the dead-code check.

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
