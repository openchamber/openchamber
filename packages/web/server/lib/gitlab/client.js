import { Gitlab } from '@gitbeaker/rest';

export function createGitLabClient({ origin, token, tokenType = 'token' }) {
  return tokenType === 'oauth'
    ? new Gitlab({ host: origin, oauthToken: token })
    : new Gitlab({ host: origin, token });
}
