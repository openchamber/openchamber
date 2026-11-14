import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { getRepositoryRemoteUrls, resolveRepositoryGitPaths } from '../git/service.js';
import { readEffectiveGitTransportRevision } from '../git/transport-config.js';
import { fingerprintRemoteUrl, isDiskPathRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import { resolveRepositoryFilesystemId } from './repository-id-storage.js';

/**
 * The ID a record is keyed by, plus the Git directory the worktree ID also
 * hashes: the repository ID, and none of what the remote and transport reads
 * answer. The contributor provenance store looks a record up on every
 * change-request status read, and the full identity would spend five more Git
 * processes per directory on fields the lookup never reads (#6084). Reads
 * that need the remotes ask for `resolveRepositoryIdentity` instead.
 */
const readRepositoryId = async (directory, { fsImpl, resolveGitPaths }) => {
  const gitPaths = await resolveGitPaths(directory);
  if (!gitPaths.supported) return gitPaths;

  const commonDirectory = await fsImpl.realpath(gitPaths.commonDirectory);
  return {
    supported: true,
    bare: gitPaths.bare,
    repositoryId: await resolveRepositoryFilesystemId(commonDirectory, { fsImpl }),
    gitDirectory: await fsImpl.realpath(gitPaths.gitDirectory),
  };
};

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
  const repositoryId = await resolveRepositoryFilesystemId(commonDirectory, { fsImpl });
  const remotes = (await getRepositoryRemotes(directory))
    .map((remote) => ({
      name: remote.name,
      fetchUrl: remote.fetchUrl || '',
      pushUrl: remote.pushUrl || remote.fetchUrl || '',
    }))
    .filter((remote) => !isDiskPathRemoteUrl(remote.fetchUrl) && !isDiskPathRemoteUrl(remote.pushUrl))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const transportRevision = includeRawEndpoints ? await getTransportRevision(directory) : undefined;
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

export function createRepositoryIdResolver({
  fsImpl = fs,
  resolveGitPaths = resolveRepositoryGitPaths,
} = {}) {
  return (directory) => readRepositoryId(directory, { fsImpl, resolveGitPaths });
}

export const resolveRepositoryId = createRepositoryIdResolver();

function createRepositoryIdentityResolver({
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
