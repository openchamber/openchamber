import { Octokit } from '@octokit/rest';
import { getGitHubAuth, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';

export function getOctokitOrNull() {
  const auth = getGitHubAuth();
  const token = auth?.accessToken || (!isGhCliDisabled() ? getGhCliToken() : null);
  if (!token) {
    return null;
  }
  return new Octokit({ auth: token });
}
