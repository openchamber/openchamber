import type { SourceControlProviderDescriptor } from './providers/descriptor';
import { joinProjectPath } from './projectPath';
import type { RepositoryUrlMatcher } from './repositoryUrlMatcher';

export interface RepositoryLinkContext {
  descriptor: SourceControlProviderDescriptor;
  origin: string;
  owner: string;
  repo: string;
}

export const repositoryLinkContextOfUrl = (url: string, matcher: RepositoryUrlMatcher): RepositoryLinkContext | null => {
  const item = matcher.match(url);
  if (!item) return null;
  return { descriptor: matcher.descriptorOf(item.provider), origin: new URL(url.trim()).origin, owner: item.owner, repo: item.repo };
};

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

type PatternValues = { owner?: string; repo?: string; number?: number; sha?: string; user?: string };

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
