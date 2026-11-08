import React from 'react';

import { useTrackerDescriptors } from './registry';
import type { TrackerDescriptor, TrackerProviderId } from './types';

/** A tracker item a link names: its tracker and its identifier, upper-cased. */
type TrackerUrlMatch = { provider: TrackerProviderId; identifier: string };

export type TrackerUrlMatcher = (url: string) => TrackerUrlMatch | null;

type CompiledPattern = { provider: TrackerProviderId; host: string; path: RegExp; query: string | null; identifier: RegExp };

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const compile = (descriptors: readonly TrackerDescriptor[]): CompiledPattern[] => descriptors.flatMap((descriptor) => {
  let identifier: RegExp;
  try {
    identifier = new RegExp(descriptor.identifierPattern);
  } catch {
    return [];
  }
  return descriptor.urlPatterns.flatMap((pattern) => {
    try {
      return [{ provider: descriptor.id, host: pattern.host.toLowerCase(), path: new RegExp(pattern.path), query: pattern.query?.name ?? null, identifier }];
    } catch {
      return [];
    }
  });
});

/**
 * Reads tracker item links against the served descriptors' `urlPatterns`,
 * the same rule as each tracker's server-side `matchUrl`: an http(s) URL
 * whose host (without `www.`) is a pattern's host and whose path matches; the
 * first group is the identifier, or the pattern's query parameter carries it,
 * checked against the descriptor's identifier pattern. Trackers are tried in
 * registry order. A tracker the registry does not hold matches no link.
 */
export const createTrackerUrlMatcher = (descriptors: readonly TrackerDescriptor[]): TrackerUrlMatcher => {
  const patterns = compile(descriptors);
  return (value) => {
    const url = patterns.length > 0 ? parseUrl(value.trim()) : null;
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    for (const pattern of patterns) {
      if (pattern.host !== host) continue;
      const match = pattern.path.exec(url.pathname);
      if (!match) continue;
      if (pattern.query === null) {
        if (match[1]) return { provider: pattern.provider, identifier: match[1].toUpperCase() };
        continue;
      }
      const candidate = url.searchParams.get(pattern.query);
      if (candidate && pattern.identifier.test(candidate)) return { provider: pattern.provider, identifier: candidate.toUpperCase() };
    }
    return null;
  };
};

/** The matcher over the connected server's trackers; one function while the list stays. */
export const useTrackerUrlMatcher = (): TrackerUrlMatcher => {
  const descriptors = useTrackerDescriptors();
  return React.useMemo(() => createTrackerUrlMatcher(descriptors), [descriptors]);
};
