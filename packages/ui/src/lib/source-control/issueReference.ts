import type { SourceControlIdentity } from './types';

type IssueReference = {
  number: number;
  identity?: SourceControlIdentity;
  project?: { owner: string; name: string };
};

export const parseIssueReference = (value: string): IssueReference | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const referenceMatch = trimmed.match(/^#?(\d+)$/u);
  if (referenceMatch) {
    const number = Number(referenceMatch[1]);
    return Number.isFinite(number) && number > 0 ? { number } : null;
  }

  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    const separatorIndex = segments.findIndex((segment, index) => (
      segment === '-' && segments[index + 1] === 'issues'
    ));
    const issuesIndex = separatorIndex >= 0
      ? separatorIndex + 1
      : segments.findIndex((segment) => segment === 'issues');
    if (issuesIndex < 2 || issuesIndex + 1 >= segments.length) return null;

    const number = Number(segments[issuesIndex + 1]);
    if (!Number.isFinite(number) || number <= 0) return null;

    const projectNameIndex = separatorIndex >= 0 ? separatorIndex - 1 : issuesIndex - 1;
    const owner = segments.slice(0, projectNameIndex).join('/');
    const name = segments[projectNameIndex];
    if (!owner || !name) return null;

    const github = url.hostname.toLowerCase() === 'github.com' && separatorIndex < 0;
    return {
      number,
      identity: github
        ? { provider: 'github', instance: 'github.com' }
        : { provider: 'gitlab', instance: url.origin },
      project: { owner, name },
    };
  } catch {
    return null;
  }
};
