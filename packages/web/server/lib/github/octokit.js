import { Octokit } from '@octokit/rest';
import { getGitHubAuth, isGhCliActive, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';

export function getOctokitOrNull() {
  const auth = getGitHubAuth();
  const ghToken = !isGhCliDisabled() ? getGhCliToken() : null;
  const token = isGhCliActive() ? ghToken || auth?.accessToken : auth?.accessToken || ghToken;
  if (!token) {
    return null;
  }
  return new Octokit({ auth: token });
}
