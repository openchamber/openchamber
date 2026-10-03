import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { getRepositoryRemoteUrls, resolveRepositoryGitPaths } from '../git/service.js';
import { readEffectiveGitTransportRevision } from '../git/transport-config.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from './url-redaction.js';

const resolveIdentity = async (directory, {
  fsImpl,
  resolveGitPaths,
  getRepositoryRemotes,
  getTransportRevision,
  includeRawEndpoints,
}) => {
  const gitPaths = await resolveGitPaths(directory);
  if (!gitPaths.supported) return gitPaths;

  const commonDirectory = await fsImpl.realpath(gitPaths.commonDirectory);
  const commonStat = await fsImpl.stat(commonDirectory);
  const remotes = (await getRepositoryRemotes(directory))
    .map((remote) => ({
      name: remote.name,
      fetchUrl: remote.fetchUrl || '',
      pushUrl: remote.pushUrl || remote.fetchUrl || '',
    }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const transportRevision = includeRawEndpoints ? await getTransportRevision(directory) : undefined;
  const repositoryId = `repo_${crypto.createHash('sha256')
    .update(commonDirectory)
    .update('\0')
    .update(String(commonStat.dev))
    .update('\0')
    .update(String(commonStat.ino))
    .digest('base64url')}`;
  // Version the binding authority so old config-byte revisions require an explicit resave.
  const configRevision = crypto.createHash('sha256')
    .update('repository-config-v2\0')
    .update(repositoryId)
    .update('\0')
    .update(JSON.stringify(remotes.map((remote) => ({
      name: remote.name,
      fetch: fingerprintRemoteUrl(remote.fetchUrl),
      push: fingerprintRemoteUrl(remote.pushUrl),
    }))))
    .digest('base64url');
  const endpoint = (rawUrl) => {
    const result = {
      displayUrl: redactRemoteUrl(rawUrl),
      fingerprint: fingerprintRemoteUrl(rawUrl),
    };
    if (includeRawEndpoints) result.rawUrl = rawUrl;
    return result;
  };

  const identity = {
    supported: true,
    repositoryId,
    configRevision,
    bare: gitPaths.bare,
    remotes: remotes.map((remote) => ({
      name: remote.name,
      fetch: endpoint(remote.fetchUrl),
      push: endpoint(remote.pushUrl),
    })),
  };
  if (transportRevision) identity.transportRevision = transportRevision;
  return identity;
};

export function createRepositoryIdentityResolver({
  fsImpl = fs,
  resolveGitPaths = resolveRepositoryGitPaths,
  getRepositoryRemotes = getRepositoryRemoteUrls,
} = {}) {
  return (directory) => resolveIdentity(directory, {
    fsImpl, resolveGitPaths, getRepositoryRemotes, getTransportRevision: null, includeRawEndpoints: false,
  });
}

export function createPrivateRepositoryIdentityResolver({
  fsImpl = fs,
  resolveGitPaths = resolveRepositoryGitPaths,
  getRepositoryRemotes = getRepositoryRemoteUrls,
  getTransportRevision = readEffectiveGitTransportRevision,
} = {}) {
  return (directory) => resolveIdentity(directory, {
    fsImpl, resolveGitPaths, getRepositoryRemotes, getTransportRevision, includeRawEndpoints: true,
  });
}

export const resolveRepositoryIdentity = createRepositoryIdentityResolver();
export const resolvePrivateRepositoryIdentity = createPrivateRepositoryIdentityResolver();
