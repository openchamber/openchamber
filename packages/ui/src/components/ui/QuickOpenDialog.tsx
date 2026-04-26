import React from 'react';
import { toast } from '@/components/ui';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

type RecentQuickOpenFile = {
  path: string;
  name: string;
  relativePath: string;
};

const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');

  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

const getRelativePath = (root: string, filePath: string): string => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(filePath);

  if (!normalizedRoot || !normalizedPath) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedRoot) {
    return normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;
  }

  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath;
};

export const QuickOpenDialog: React.FC = () => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const isQuickOpenOpen = useUIStore((state) => state.isQuickOpenOpen);
  const setQuickOpenOpen = useUIStore((state) => state.setQuickOpenOpen);
  const openContextFile = useUIStore((state) => state.openContextFile);
  const effectiveDirectory = useEffectiveDirectory();
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const currentRoot = React.useMemo(
    () => (effectiveDirectory ? normalizePath(effectiveDirectory) : undefined),
    [effectiveDirectory],
  );
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const [searchResults, setSearchResults] = React.useState<RecentQuickOpenFile[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const rootTabs = useFilesViewTabsStore(
    React.useCallback(
      (state) => (currentRoot ? state.byRoot[currentRoot] : undefined),
      [currentRoot],
    ),
  );

  const recentFiles = React.useMemo(() => {
    if (!currentRoot || !rootTabs) {
      return [] as RecentQuickOpenFile[];
    }

    const orderedPaths = [
      rootTabs.selectedPath,
      ...rootTabs.openPaths,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const seen = new Set<string>();

    return orderedPaths
      .map((filePath) => normalizePath(filePath))
      .filter((filePath) => {
        if (!filePath || seen.has(filePath)) {
          return false;
        }

        seen.add(filePath);
        return true;
      })
      .slice(0, 10)
      .map((filePath) => {
        const name = filePath.split('/').filter(Boolean).pop() || filePath;
        return {
          path: filePath,
          name,
          relativePath: getRelativePath(currentRoot, filePath),
        } satisfies RecentQuickOpenFile;
      });
  }, [currentRoot, rootTabs]);

  const trimmedQuery = debouncedQuery.trim();

  React.useEffect(() => {
    if (!isQuickOpenOpen) {
      setQuery('');
      setSearchResults([]);
      setIsSearching(false);
    }
  }, [isQuickOpenOpen]);

  React.useEffect(() => {
    if (!currentRoot || trimmedQuery.length === 0) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    void searchFiles(currentRoot, trimmedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      type: 'file',
    })
      .then((results) => {
        if (cancelled) {
          return;
        }

        setSearchResults(results.map((file) => ({
          path: normalizePath(file.path),
          name: file.name,
          relativePath: file.relativePath,
        })));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setSearchResults([]);
      })
      .finally(() => {
        if (!cancelled) {
          setIsSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentRoot, searchFiles, showGitignored, showHidden, trimmedQuery]);

  const handleSelectFile = React.useCallback(async (filePath: string) => {
    if (!currentRoot) {
      return;
    }

    const openValidation = await validateContextFileOpen(files, filePath);
    if (!openValidation.ok) {
      toast.error(getContextFileOpenFailureMessage(openValidation.reason));
      return;
    }

    openContextFile(currentRoot, filePath);
    setQuickOpenOpen(false);
  }, [currentRoot, files, openContextFile, setQuickOpenOpen]);

  const hasTypedQuery = query.trim().length > 0;
  const visibleFiles = hasTypedQuery ? searchResults : recentFiles;
  const emptyMessage = !currentRoot
    ? t('quickOpenDialog.empty.openProjectFirst')
    : hasTypedQuery
      ? (isSearching ? t('quickOpenDialog.empty.searchingFiles') : t('quickOpenDialog.empty.noMatchingFiles'))
      : t('quickOpenDialog.empty.noMatchingRecentFiles');

  return (
    <Dialog open={isQuickOpenOpen} onOpenChange={setQuickOpenOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t('quickOpenDialog.title')}</DialogTitle>
        <DialogDescription>{t('quickOpenDialog.description')}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className="overflow-hidden p-0 transform-gpu will-change-transform"
        showCloseButton
      >
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-8 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 [&_[cmdk-item]]:typography-meta"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('quickOpenDialog.input.placeholder')}
            disabled={!currentRoot}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>

            {currentRoot && visibleFiles.length > 0 && (
              <CommandGroup heading={hasTypedQuery ? t('quickOpenDialog.group.files') : t('quickOpenDialog.group.recentFiles')}>
                {visibleFiles.map((file) => (
                  <CommandItem
                    key={file.path}
                    value={file.path}
                    onSelect={() => {
                      void handleSelectFile(file.path);
                    }}
                  >
                    <FileTypeIcon filePath={file.path} className="size-4 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate">{file.name}</span>
                      <span className="truncate text-muted-foreground">{file.relativePath}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
