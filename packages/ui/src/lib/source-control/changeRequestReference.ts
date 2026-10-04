import type { SourceControlIdentity } from './types';

type ChangeRequestReference = {
  number: number;
  identity?: SourceControlIdentity;
  project?: { owner: string; name: string };
};

const positiveNumber = (value: string): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export const parseChangeRequestReference = (value: string): ChangeRequestReference | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const referenceMatch = trimmed.match(/^[#!]?(\d+)$/u);
  if (referenceMatch) {
    const number = positiveNumber(referenceMatch[1]);
    return number ? { number } : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.toLowerCase() === 'github.com') {
    const pullIndex = segments.findIndex((segment) => segment === 'pull');
    if (pullIndex !== 2 || pullIndex + 1 >= segments.length) return null;
    const number = positiveNumber(segments[pullIndex + 1]);
    if (!number) return null;
    return {
      number,
      identity: { provider: 'github', instance: 'github.com' },
      project: { owner: segments[0], name: segments[1] },
    };
  }

  const separatorIndex = segments.findIndex((segment, index) => (
    segment === '-' && segments[index + 1] === 'merge_requests'
  ));
  if (separatorIndex < 2 || separatorIndex + 2 >= segments.length) return null;
  const number = positiveNumber(segments[separatorIndex + 2]);
  const name = segments[separatorIndex - 1];
  const owner = segments.slice(0, separatorIndex - 1).join('/');
  if (!number || !owner || !name) return null;
  return {
    number,
    identity: { provider: 'gitlab', instance: url.origin },
    project: { owner, name },
  };
};
