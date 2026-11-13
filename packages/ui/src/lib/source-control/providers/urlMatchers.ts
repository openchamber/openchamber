import type { RepositoryReferenceKind } from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from './descriptor';
import { splitProjectPath } from '../projectPath';

/** An issue, change request or discussion a link names, and the provider instance it lives on. */
export interface RepositoryItemUrlMatch {
  provider: SourceControlProviderDescriptor['id'];
  instance: string;
  /**
   * The owner, or for nested namespaces the whole namespace path
   * (`group/subgroup`). Empty for a top-level project of a path-style provider.
   */
  owner: string;
  repo: string;
  number: number;
  kind: RepositoryReferenceKind;
}

interface CompiledPattern {
  kind: RepositoryReferenceKind;
  regex: RegExp;
  /** Groups of `{owner}`/`{namespace+}` and `{repo}`, or of the whole `{project+}` path. */
  project: { owner: number; repo: number } | { path: number };
  number: number;
}

const PLACEHOLDER_SOURCE: ReadonlyMap<string, string> = new Map([
  ['{owner}', '([^/]+)'],
  ['{namespace+}', '([^/]+(?:/[^/]+)*?)'],
  ['{project+}', '([^/]+(?:/[^/]+)*?)'],
  ['{repo}', '([^/]+)'],
  ['{number}', '(\\d+)'],
]);

const escapeLiteral = (segment: string): string => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A descriptor URL pattern as a regular expression over the link's path, or
 * null when it does not name exactly one owner (or namespace) and repo, or one
 * whole project path (`{project+}`), and one number.
 * Literal segments compare case-insensitively; the path may continue after
 * the number (`/pull/12/files`).
 */
const compilePattern = (pattern: string, kind: RepositoryReferenceKind): CompiledPattern | null => {
  const groups: string[] = [];
  let source = '^';
  for (const segment of pattern.split('/').filter(Boolean)) {
    const placeholder = PLACEHOLDER_SOURCE.get(segment);
    if (placeholder) {
      groups.push(segment === '{namespace+}' ? '{owner}' : segment);
      source += `/${placeholder}`;
    } else if (/[{}]/.test(segment)) {
      return null;
    } else {
      source += `/${escapeLiteral(segment)}`;
    }
  }
  const owner = groups.indexOf('{owner}');
  const repo = groups.indexOf('{repo}');
  const path = groups.indexOf('{project+}');
  const number = groups.indexOf('{number}');
  if (number < 0 || new Set(groups).size !== groups.length) return null;
  const project = path >= 0
    ? (owner < 0 && repo < 0 ? { path: path + 1 } : null)
    : (owner >= 0 && repo >= 0 ? { owner: owner + 1, repo: repo + 1 } : null);
  if (!project) return null;
  return { kind, regex: new RegExp(`${source}(?:/.*)?$`, 'i'), project, number: number + 1 };
};

const compiledByDescriptor = new WeakMap<SourceControlProviderDescriptor, CompiledPattern[]>();

const patternsOf = (descriptor: SourceControlProviderDescriptor): CompiledPattern[] => {
  const cached = compiledByDescriptor.get(descriptor);
  if (cached) return cached;
  const compiled = [
    ...descriptor.urls.changeRequest.map((pattern) => compilePattern(pattern, 'pull')),
    ...descriptor.urls.issue.map((pattern) => compilePattern(pattern, 'issue')),
    // Only a host that keeps discussions names them; its links are discussions only then.
    ...(descriptor.features.discussions ? descriptor.urls.discussion.map((pattern) => compilePattern(pattern, 'discussion')) : []),
  ].filter((pattern): pattern is CompiledPattern => pattern !== null);
  compiledByDescriptor.set(descriptor, compiled);
  return compiled;
};

const instanceOfHost = (url: URL, descriptor: SourceControlProviderDescriptor): string => (
  descriptor.instances.format === 'host' ? url.hostname.toLowerCase().replace(/\.$/, '') : url.origin
);

/** The instance a link names; `www.` in front of the default instance's host names the default instance. */
const instanceOf = (url: URL, descriptor: SourceControlProviderDescriptor): string => {
  const instance = instanceOfHost(url, descriptor);
  const fallback = descriptor.instances.defaultInstance;
  if (!fallback || !url.hostname.toLowerCase().startsWith('www.')) return instance;
  const bare = new URL(url.href);
  bare.hostname = url.hostname.slice(4);
  return instanceOfHost(bare, descriptor) === fallback ? fallback : instance;
};

const matchDescriptor = (url: URL, descriptor: SourceControlProviderDescriptor): RepositoryItemUrlMatch | null => {
  for (const pattern of patternsOf(descriptor)) {
    const found = pattern.regex.exec(url.pathname);
    if (!found) continue;
    const { owner, repo } = 'path' in pattern.project
      ? splitProjectPath(found[pattern.project.path])
      : { owner: found[pattern.project.owner], repo: found[pattern.project.repo] };
    return {
      provider: descriptor.id,
      instance: instanceOf(url, descriptor),
      owner,
      repo,
      number: Number(found[pattern.number]),
      kind: pattern.kind,
    };
  }
  return null;
};

/**
 * The issue or change request a link names, read against the providers'
 * URL patterns. `descriptors` are in registry order.
 *
 * 1. A provider whose instance the host is known to be (a connected account's
 *    instance, or the provider's default instance) wins.
 * 2. Otherwise the only provider whose pattern matches.
 * 3. When several match, the first by `order`: an unknown host with
 *    `/issues/N` or `/pull/N` keeps reading as GitHub-shaped.
 */
export const parseRepositoryItemUrl = (
  link: string,
  descriptors: readonly SourceControlProviderDescriptor[],
  knownIdentities: ReadonlyArray<{ provider: string; instance: string }>,
): RepositoryItemUrlMatch | null => {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  let first: RepositoryItemUrlMatch | null = null;
  for (const descriptor of descriptors) {
    const match = matchDescriptor(url, descriptor);
    if (!match) continue;
    const known = descriptor.instances.defaultInstance === match.instance
      || knownIdentities.some((identity) => identity.provider === descriptor.id && identity.instance === match.instance);
    if (known) return match;
    first ??= match;
  }
  return first;
};
