import React from 'react';

import type {
  FileContentSearchMatch,
  FileContentSearchQuery,
  FileContentSearchOutcome,
  FileContentSearchStop,
} from '@/lib/api/types';

const FILE_CONTENT_SEARCH_LIMIT = 200;

/** Identifies one result row; a file matching on several lines has several. */
export const fileContentMatchKey = (match: FileContentSearchMatch): string => `${match.path}:${match.line}:${match.column}`;

export type FileContentSearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'results'; matches: FileContentSearchMatch[]; stopped: FileContentSearchStop | null }
  | { status: 'invalid-pattern'; message: string }
  | { status: 'unavailable' }
  | { status: 'failed'; message: string };

type Options = {
  /** The runtime's find-in-files, or undefined where the runtime has none. */
  searchContents: ((payload: FileContentSearchQuery) => Promise<FileContentSearchOutcome>) | undefined;
  directory: string;
  /** Already debounced by the caller; every change here starts a request. */
  query: string;
  regex: boolean;
  includeHidden: boolean;
  respectGitignore: boolean;
  /** False while the surface is hidden or in another search mode: no requests, idle state. */
  active: boolean;
};

const IDLE: FileContentSearchState = { status: 'idle' };

/**
 * Runs find-in-files for the query and reports where it stands. A change of
 * query or options aborts the request in flight, which also ends the server's
 * ripgrep process, and a late answer from an aborted request never lands.
 */
export const useFileContentSearch = ({
  searchContents,
  directory,
  query,
  regex,
  includeHidden,
  respectGitignore,
  active,
}: Options): FileContentSearchState => {
  const [state, setState] = React.useState<FileContentSearchState>(IDLE);

  React.useEffect(() => {
    if (!active || !searchContents || !directory || !query.trim()) {
      setState(IDLE);
      return;
    }

    const abort = new AbortController();
    let cancelled = false;
    setState({ status: 'searching' });

    searchContents({
      directory,
      query,
      regex,
      limit: FILE_CONTENT_SEARCH_LIMIT,
      includeHidden,
      respectGitignore,
      signal: abort.signal,
    })
      .then((outcome) => {
        if (cancelled) return;
        setState(outcome.status === 'ok'
          ? { status: 'results', matches: outcome.matches, stopped: outcome.stopped }
          : outcome);
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [active, directory, includeHidden, query, regex, respectGitignore, searchContents]);

  return state;
};
