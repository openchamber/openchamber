import type { SourceControlRepositoryRemote } from '@openchamber/ui/lib/api/types';
import { isSafeRepositoryEndpoint } from '../../server/lib/source-control/binding-contract.js';
import { isStringValue } from './boundary-guards';

const SSH_HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export const parseRepositoryRemote = (remote: SourceControlRepositoryRemote): SourceControlRepositoryRemote => {
  if (!remote || !isStringValue(remote.name) || !remote.name
    || !isSafeRepositoryEndpoint(remote.fetch) || !isSafeRepositoryEndpoint(remote.push)) {
    throw new Error('Source control response contained an invalid repository remote');
  }
  const parsed: SourceControlRepositoryRemote = {
    name: remote.name,
    fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
    push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
  };
  if (isStringValue(remote.sshHostName) && SSH_HOST_NAME.test(remote.sshHostName)) parsed.sshHostName = remote.sshHostName;
  return parsed;
};
