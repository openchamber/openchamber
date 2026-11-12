import type { SourceControlProviderDescriptor } from './providers/descriptor';
import { joinProjectPath } from './projectPath';
import type { RepositoryUrlMatcher } from './repositoryUrlMatcher';

/**
 * The repository an issue or change request lives in, as its text needs it to
 * link `#12`, `owner/repo#12`, `@someone` and commit ids: the provider's URL
 * patterns, the instance origin and the project path.
 */
export interface RepositoryLinkContext {
  descriptor: SourceControlProviderDescriptor;
  origin: string;
  owner: string;
  repo: string;
}

/** The link context of the item a URL names; null for anything the matcher does not read as one. */
export const repositoryLinkContextOfUrl = (url: string, matcher: RepositoryUrlMatcher): RepositoryLinkContext | null => {
  const item = matcher.match(url);
  if (!item) return null;
  return { descriptor: matcher.descriptorOf(item.provider), origin: new URL(url.trim()).origin, owner: item.owner, repo: item.repo };
};

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

type PatternValues = { owner?: string; repo?: string; number?: number; sha?: string; user?: string };

/** A descriptor URL pattern with its placeholders filled; null when it names one the values do not give. */
const fillPattern = (pattern: string | undefined, values: PatternValues): string | null => {
  if (!pattern) return null;
  const project = values.repo !== undefined ? joinProjectPath(values.owner ?? '', values.repo) : undefined;
  const byToken = new Map([
    ['{owner}', values.owner], ['{namespace+}', values.owner], ['{repo}', values.repo], ['{project+}', project],
    ['{number}', values.number === undefined ? undefined : String(values.number)], ['{sha}', values.sha], ['{user}', values.user],
  ]);
  const segments: string[] = [];
  for (const segment of pattern.split('/').filter(Boolean)) {
    if (!/^\{.*\}$/.test(segment)) { segments.push(encodeURIComponent(segment)); continue; }
    const value = byToken.get(segment);
    if (!value) return null;
    segments.push(encodePath(value));
  }
  return `/${segments.join('/')}`;
};

const linkOf = (context: RepositoryLinkContext, pattern: string | undefined, values: PatternValues): string | null => {
  const path = fillPattern(pattern, values);
  return path ? `${context.origin}${path}` : null;
};

/**
 * An issue's or change request's page in the context's repository, or in
 * `project` on the same instance. A provider that numbers both alike links an
 * issue number, which the host's page resolves to whichever of the two it is.
 */
export const repositoryItemLink = (
  context: RepositoryLinkContext,
  kind: 'issue' | 'pull',
  number: number,
  project: { owner: string; repo: string } = context,
): string | null => linkOf(
  context,
  kind === 'pull' ? context.descriptor.urls.changeRequest[0] : context.descriptor.urls.issue[0],
  { owner: project.owner, repo: project.repo, number },
);

export const repositoryCommitLink = (context: RepositoryLinkContext, sha: string): string | null => (
  linkOf(context, context.descriptor.urls.commit[0], { owner: context.owner, repo: context.repo, sha })
);

export const repositoryUserLink = (context: RepositoryLinkContext, user: string): string | null => (
  linkOf(context, context.descriptor.urls.user[0], { user })
);

const PATTERN_SOURCE: ReadonlyMap<string, string> = new Map([
  ['{owner}', '[^/]+'],
  ['{namespace+}', '[^/]+(?:/[^/]+)*?'],
  ['{project+}', '[^/]+(?:/[^/]+)*?'],
  ['{repo}', '[^/]+'],
  ['{sha}', '([0-9a-f]{7,64})'],
]);

const compiledCommitPatterns = new WeakMap<SourceControlProviderDescriptor, RegExp[]>();

const commitPatternsOf = (descriptor: SourceControlProviderDescriptor): RegExp[] => {
  const cached = compiledCommitPatterns.get(descriptor);
  if (cached) return cached;
  const compiled = descriptor.urls.commit.flatMap((pattern) => {
    let source = '^';
    for (const segment of pattern.split('/').filter(Boolean)) {
      const placeholder = PATTERN_SOURCE.get(segment);
      if (placeholder) source += `/${placeholder}`;
      else if (/[{}]/.test(segment)) return [];
      else source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    }
    return pattern.includes('{sha}') ? [new RegExp(`${source}(?:/.*)?$`, 'i')] : [];
  });
  compiledCommitPatterns.set(descriptor, compiled);
  return compiled;
};

/** The commit id a link to a commit page names, read against the providers' commit patterns; null for anything else. */
export const commitShaOfUrl = (link: string, descriptors: readonly SourceControlProviderDescriptor[]): string | null => {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  for (const descriptor of descriptors) {
    for (const pattern of commitPatternsOf(descriptor)) {
      const sha = pattern.exec(url.pathname)?.[1];
      if (sha) return sha.toLowerCase();
    }
  }
  return null;
};
