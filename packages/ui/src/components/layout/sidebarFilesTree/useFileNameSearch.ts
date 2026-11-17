import React from 'react';

import { useFileSearchStore } from '@/stores/useFileSearchStore';
import type { FileNode } from './fileNode';
import { normalizePath, shouldIgnorePath } from './treePaths';

export const useFileNameSearch = ({
  visible,
  currentDirectory,
  contentSearchActive,
  query,
  showHidden,
  showGitignored,
}: {
  visible: boolean;
  currentDirectory: string;
  contentSearchActive: boolean;
  query: string;
  showHidden: boolean;
  showGitignored: boolean;
}) => {
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    if (!currentDirectory || contentSearchActive) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
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
        if (cancelled) return;

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

        const mapped: FileNode[] = filtered.map((hit) => ({
          name: hit.name,
          path: normalizePath(hit.path),
          type: 'file',
          extension: hit.extension,
          relativePath: hit.relativePath,
        }));

        setSearchResults(mapped);
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
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
  }, [contentSearchActive, currentDirectory, query, searchFiles, showHidden, showGitignored, visible]);

  return { searchResults, searching };
};
