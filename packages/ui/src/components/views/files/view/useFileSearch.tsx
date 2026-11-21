import React from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { type FileNode } from './fileViewTypes';
import { normalizePath } from './fileViewPaths';
import { shouldIgnorePath } from './fileViewEntries';
import { type useFileScope } from './useFileScope';

export function useFileSearch({ scope }: {
  scope: Pick<ReturnType<typeof useFileScope>, 'currentDirectory' | 'showGitignored' | 'showHidden'>;
}) {
  const { currentDirectory, showGitignored, showHidden } = scope;
  const searchFiles = useFileSearchStore((state) => state.searchFiles);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [resultsFor, setResultsFor] = React.useState<{ directory: string; query: string } | null>(null);
  const [searching, setSearching] = React.useState(false);
  React.useEffect(() => {
    if (!currentDirectory) {
      setSearchResults([]);
      setResultsFor(null);
      setSearching(false);
      return;
    }

    const trimmedQuery = debouncedSearchQuery.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setResultsFor(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    searchFiles(currentDirectory, trimmedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) {
          return;
        }

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

        const mapped: FileNode[] = filtered.map((hit) => ({
          name: hit.name,
          path: normalizePath(hit.path),
          type: 'file',
          extension: hit.extension,
          relativePath: hit.relativePath,
        }));

        setSearchResults(mapped);
        setResultsFor({ directory: currentDirectory, query: trimmedQuery });
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
          setResultsFor(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, debouncedSearchQuery, searchFiles, showHidden, showGitignored]);

  return { searchQuery, setSearchQuery, debouncedSearchQuery, searchInputRef, searchResults, resultsFor, searching };
}
