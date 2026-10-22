import React from 'react';

import { useTrackerDescriptors } from './registry';
import type { TrackerDescriptor, TrackerProviderId } from './types';

/** A tracker item a link names: its tracker and its identifier, upper-cased. */
type TrackerUrlMatch = { provider: TrackerProviderId; identifier: string };

export type TrackerUrlMatcher = (url: string) => TrackerUrlMatch | null;

type CompiledPattern = { provider: TrackerProviderId; host: string; path: RegExp };

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const compile = (descriptors: readonly TrackerDescriptor[]): CompiledPattern[] => descriptors.flatMap((descriptor) => (
  descriptor.urlPatterns.flatMap((pattern) => {
    try {
      return [{ provider: descriptor.id, host: pattern.host.toLowerCase(), path: new RegExp(pattern.path) }];
    } catch {
      return [];
    }
  })
));

/**
 * Reads tracker item links against the served descriptors' `urlPatterns`,
 * the same rule as each tracker's server-side `matchUrl`: an http(s) URL
 * whose host (without `www.`) is a pattern's host and whose path matches; the
 * first group is the identifier. Trackers are tried in registry order. A
 * tracker the registry does not hold matches no link.
 */
export const createTrackerUrlMatcher = (descriptors: readonly TrackerDescriptor[]): TrackerUrlMatcher => {
  const patterns = compile(descriptors);
  return (value) => {
    const url = patterns.length > 0 ? parseUrl(value.trim()) : null;
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    for (const pattern of patterns) {
      if (pattern.host !== host) continue;
      const identifier = pattern.path.exec(url.pathname)?.[1];
      if (identifier) return { provider: pattern.provider, identifier: identifier.toUpperCase() };
    }
    return null;
  };
};

/** The matcher over the connected server's trackers; one function while the list stays. */
export const useTrackerUrlMatcher = (): TrackerUrlMatcher => {
  const descriptors = useTrackerDescriptors();
  return React.useMemo(() => createTrackerUrlMatcher(descriptors), [descriptors]);
};
