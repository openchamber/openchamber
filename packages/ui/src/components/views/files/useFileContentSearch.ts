import React from 'react';

import type {
  FileContentSearchMatch,
  FileContentSearchQuery,
  FileContentSearchOutcome,
  FileContentSearchStop,
} from '@/lib/api/types';

const FILE_CONTENT_SEARCH_LIMIT = 200;

export const fileContentMatchKey = (match: FileContentSearchMatch): string => `${match.path}:${match.line}:${match.column}`;

export type FileContentSearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'results'; matches: FileContentSearchMatch[]; stopped: FileContentSearchStop | null }
  | { status: 'invalid-pattern'; message: string }
  | { status: 'unavailable' }
  | { status: 'failed'; message: string };

type Options = {
  searchContents: ((payload: FileContentSearchQuery) => Promise<FileContentSearchOutcome>) | undefined;
  directory: string;
  query: string;
  regex: boolean;
  includeHidden: boolean;
  respectGitignore: boolean;
  active: boolean;
};

const IDLE: FileContentSearchState = { status: 'idle' };

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
