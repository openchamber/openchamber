import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { getRepositoryRemoteUrls, resolveRepositoryGitPaths } from '../git/service.js';
import { readEffectiveGitTransportRevision } from '../git/transport-config.js';
import { fingerprintRemoteUrl, isDiskPathRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import { resolveRepositoryFilesystemId } from './repository-id-storage.js';
import type { PlannedRemote } from '../git/service-contracts.js';
import type { RepositoryIdentity, RepositoryResolution } from './binding-service-contracts.js';
import type { SourceControlRepositoryEndpoint } from './binding-types.js';

export interface RepositoryIdResolverOptions {
  fsImpl?: typeof fs;
  resolveGitPaths?: typeof resolveRepositoryGitPaths;
}
export interface RepositoryIdentityResolverOptions extends RepositoryIdResolverOptions {
  getRepositoryRemotes?: typeof getRepositoryRemoteUrls;
}
export interface PrivateRepositoryIdentityResolverOptions extends RepositoryIdentityResolverOptions {
  getTransportRevision?: typeof readEffectiveGitTransportRevision;
}
export type RepositoryIdResolution = { supported: false; reason: string } | {
  supported: true;
  bare: boolean;
  repositoryId: string;
  gitDirectory: string;
};
type IdentityDependencies = Required<RepositoryIdentityResolverOptions> & {
  getTransportRevision: typeof readEffectiveGitTransportRevision;
  includeRawEndpoints: true;
} | Required<RepositoryIdentityResolverOptions> & {
  getTransportRevision: null;
  includeRawEndpoints: false;
};

const readRepositoryId = async (directory: string, { fsImpl, resolveGitPaths }: Required<RepositoryIdResolverOptions>): Promise<RepositoryIdResolution> => {
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

const resolveIdentity = async (directory: string, {
  fsImpl,
  resolveGitPaths,
  getRepositoryRemotes,
  getTransportRevision,
  includeRawEndpoints,
}: IdentityDependencies, plannedRemote?: PlannedRemote): Promise<RepositoryResolution> => {
  const gitPaths = await resolveGitPaths(directory);
  if (!gitPaths.supported) return gitPaths;

  const commonDirectory = await fsImpl.realpath(gitPaths.commonDirectory);
  const repositoryId = await resolveRepositoryFilesystemId(commonDirectory, { fsImpl });
  const remotes = (await getRepositoryRemotes(directory, plannedRemote))
    .map((remote) => ({
      name: remote.name,
      fetchUrl: remote.fetchUrl || '',
      pushUrl: remote.pushUrl || remote.fetchUrl || '',
    }))
    .filter((remote) => !isDiskPathRemoteUrl(remote.fetchUrl) && !isDiskPathRemoteUrl(remote.pushUrl))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const transportRevision = includeRawEndpoints ? await getTransportRevision(directory) : undefined;
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
  const endpoint = (rawUrl: string) => {
    const result: SourceControlRepositoryEndpoint & { rawUrl?: string } = {
      displayUrl: redactRemoteUrl(rawUrl),
      fingerprint: fingerprintRemoteUrl(rawUrl),
    };
    if (includeRawEndpoints) result.rawUrl = rawUrl;
    return result;
  };

  const identity: RepositoryIdentity = {
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
}: RepositoryIdResolverOptions = {}) {
  return (directory: string) => readRepositoryId(directory, { fsImpl, resolveGitPaths });
}

export const resolveRepositoryId = createRepositoryIdResolver();

function createRepositoryIdentityResolver({
  fsImpl = fs,
  resolveGitPaths = resolveRepositoryGitPaths,
  getRepositoryRemotes = getRepositoryRemoteUrls,
}: RepositoryIdentityResolverOptions = {}) {
  return (directory: string, plannedRemote?: PlannedRemote) => resolveIdentity(directory, {
    fsImpl, resolveGitPaths, getRepositoryRemotes, getTransportRevision: null, includeRawEndpoints: false,
  }, plannedRemote);
}

export function createPrivateRepositoryIdentityResolver({
  fsImpl = fs,
  resolveGitPaths = resolveRepositoryGitPaths,
  getRepositoryRemotes = getRepositoryRemoteUrls,
  getTransportRevision = readEffectiveGitTransportRevision,
}: PrivateRepositoryIdentityResolverOptions = {}) {
  return (directory: string) => resolveIdentity(directory, {
    fsImpl, resolveGitPaths, getRepositoryRemotes, getTransportRevision, includeRawEndpoints: true,
  });
}

export const resolveRepositoryIdentity = createRepositoryIdentityResolver();
export const resolvePrivateRepositoryIdentity = createPrivateRepositoryIdentityResolver();
