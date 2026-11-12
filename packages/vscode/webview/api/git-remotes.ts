/**
 * Repository remotes for the VS Code webview.
 *
 * VS Code has no source-control binding store. The shared Git surfaces still
 * read a repository context and a binding before any network operation, so the
 * webview projects the repository's remotes as a ready System-transport binding.
 * System Git on the extension host then performs the transfer with whatever
 * credentials the user's Git setup already provides, exactly as before the
 * binding model existed.
 */

import type {
  GitRemote,
  SourceControlBindingRead,
  SourceControlRepositoryContext,
  SourceControlRepositoryRemote,
} from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Strips HTTP userinfo, query and fragment. scp-like remotes are returned trimmed. */
const redactRemoteUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!URL_SCHEME.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
};

/** FNV-1a over the redacted URL. Fingerprints only need equality within one repository. */
const digest = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const endpoint = (url: string) => {
  const displayUrl = redactRemoteUrl(url);
  return { displayUrl, fingerprint: digest(displayUrl) };
};

export const readRepositoryRemotes = async (directory: string): Promise<GitRemote[]> => {
  const remotes = await sendBridgeMessage<GitRemote[]>('api:git/remotes', { directory });
  return remotes.map((remote) => ({
    name: remote.name,
    fetchUrl: redactRemoteUrl(remote.fetchUrl),
    pushUrl: redactRemoteUrl(remote.pushUrl),
  }));
};

export const readRepositoryContext = async (directory: string): Promise<SourceControlRepositoryContext> => {
  if (!directory.trim()) throw new Error('Directory is required');
  const remotes: SourceControlRepositoryRemote[] = (await readRepositoryRemotes(directory)).map((remote) => ({
    name: remote.name,
    fetch: endpoint(remote.fetchUrl),
    push: endpoint(remote.pushUrl),
  }));
  const topology = remotes
    .map((remote) => [remote.name, remote.fetch.fingerprint, remote.push.fingerprint])
    .sort((left, right) => left[0].localeCompare(right[0]));
  return {
    repositoryId: `vscode:${directory}`,
    configRevision: `remotes-${digest(JSON.stringify(topology))}`,
    bare: false,
    remotes,
  };
};

export const readSystemRepositoryBinding = async (directory: string): Promise<SourceControlBindingRead> => {
  const repository = await readRepositoryContext(directory);
  return {
    status: 'bound',
    repository,
    revision: 1,
    binding: {
      repositoryId: repository.repositoryId,
      revision: 1,
      configRevision: repository.configRevision,
      state: 'bound',
      providers: [],
      auxiliary: [],
      remotes: repository.remotes.map((remote) => ({ ...remote, mode: 'system', readiness: 'ready' })),
    },
  };
};
