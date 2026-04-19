import React from 'react';
import { RiFolderLine, RiRefreshLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { opencodeClient, type FilesystemEntry } from '@/lib/opencode/client';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { normalizePath } from '@/lib/pathUtils';

interface DirectoryAutocompleteProps {
  inputValue: string;
  homeDirectory: string | null;
  scopeBoundary?: string | null;
  onSelectSuggestion: (path: string) => void;
  visible: boolean;
  onClose: () => void;
  showHidden: boolean;
}

export interface DirectoryAutocompleteHandle {
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean;
}

type AutocompleteItem =
  | { kind: 'parent'; path: string }
  | { kind: 'directory'; entry: FilesystemEntry };

export const DirectoryAutocomplete = React.forwardRef<DirectoryAutocompleteHandle, DirectoryAutocompleteProps>(({ 
  inputValue,
  homeDirectory,
  scopeBoundary = null,
  onSelectSuggestion,
  visible,
  onClose,
  showHidden,
}, ref) => {
  const isWindowsRuntime = React.useMemo(
    () => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent),
    []
  );
  const [suggestions, setSuggestions] = React.useState<FilesystemEntry[]>([]);
  const [navigationParentPath, setNavigationParentPath] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [mountedDriveSuggestions, setMountedDriveSuggestions] = React.useState<FilesystemEntry[] | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  // Fuzzy matching score - returns null if no match, higher score = better match
  const fuzzyScore = React.useCallback((query: string, candidate: string): number | null => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return 0;
    }

    const c = candidate.toLowerCase();
    let score = 0;
    let lastIndex = -1;
    let consecutive = 0;

    for (let i = 0; i < q.length; i += 1) {
      const ch = q[i];
      if (!ch || ch === ' ') {
        continue;
      }

      const idx = c.indexOf(ch, lastIndex + 1);
      if (idx === -1) {
        return null; // Character not found - no match
      }

      const gap = idx - lastIndex - 1;
      if (gap === 0) {
        consecutive += 1;
      } else {
        consecutive = 0;
      }

      score += 10; // Base score per matched char
      score += Math.max(0, 18 - idx); // Bonus for early matches
      score -= Math.max(0, gap); // Penalty for gaps

      // Bonus for match at start or after separator
      if (idx === 0) {
        score += 12;
      } else {
        const prev = c[idx - 1];
        if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
          score += 10;
        }
      }

      score += consecutive > 0 ? 12 : 0; // Bonus for consecutive matches
      lastIndex = idx;
    }

    score += Math.max(0, 24 - Math.round(c.length / 3)); // Shorter names score higher
    return score;
  }, []);

  // Expand ~ to home directory
  const expandPath = React.useCallback((path: string): string => {
    let normalizedPath = path.trim().replace(/\\/g, '/');
    if (/^[A-Za-z]:$/.test(normalizedPath)) {
      normalizedPath = `${normalizedPath}/`;
    }
    if (/^%userprofile%(?:[\\/]|$)/i.test(path) && homeDirectory) {
      return normalizedPath.replace(/^%userprofile%/i, homeDirectory);
    }
    if (normalizedPath.startsWith('~') && homeDirectory) {
      return normalizedPath.replace(/^~/, homeDirectory);
    }
    return normalizedPath;
  }, [homeDirectory]);

  const normalizedScopeBoundary = React.useMemo(
    () => normalizePath(scopeBoundary ?? null),
    [scopeBoundary]
  );

  const isWindowsPathContext = React.useMemo(() => {
    if (!isWindowsRuntime) {
      return false;
    }

    const values = [inputValue, homeDirectory, scopeBoundary];
    return values.some((value) => {
      if (typeof value !== 'string') {
        return false;
      }

      const trimmed = value.trim();
      return /^\/[A-Za-z](?:\/|$)?/.test(trimmed) || /^[A-Za-z]:(?:[\\/]|$)?/.test(trimmed);
    });
  }, [homeDirectory, inputValue, isWindowsRuntime, scopeBoundary]);

  const normalizeResolvedPath = React.useCallback((path: string): string => {
    const expanded = expandPath(path);
    return normalizePath(expanded) ?? expanded.replace(/\\/g, '/');
  }, [expandPath]);

  const toRequestPath = React.useCallback((path: string): string => {
    const normalized = normalizeResolvedPath(path);
    const converted = normalized.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`);
    return /^[A-Za-z]:$/.test(converted) ? `${converted}/` : converted;
  }, [normalizeResolvedPath]);

  const isWithinScopeBoundary = React.useCallback((path: string | null | undefined): boolean => {
    if (!normalizedScopeBoundary) {
      return true;
    }

    if (typeof path !== 'string' || path.length === 0) {
      return false;
    }

    const normalized = normalizeResolvedPath(path);
    if (normalizedScopeBoundary === '/') {
      return normalized.startsWith('/');
    }

    return normalized === normalizedScopeBoundary || normalized.startsWith(`${normalizedScopeBoundary}/`);
  }, [normalizedScopeBoundary, normalizeResolvedPath]);

  const getParentDirectory = React.useCallback((path: string): string | null => {
    const normalized = normalizeResolvedPath(path);
    if (!normalized) {
      return null;
    }

    if (normalizedScopeBoundary && normalized === normalizedScopeBoundary) {
      return null;
    }

    if (normalized === '/') {
      return null;
    }

    if (/^\/[A-Za-z]$/.test(normalized)) {
      if (!normalizedScopeBoundary && isWindowsPathContext && mountedDriveSuggestions && mountedDriveSuggestions.length > 0) {
        return '/';
      }
      return null;
    }

    const lastSlash = normalized.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : normalized.slice(0, lastSlash);

    if (!normalizedScopeBoundary) {
      return parent || '/';
    }

    if (parent === normalizedScopeBoundary || parent.startsWith(`${normalizedScopeBoundary}/`)) {
      return parent;
    }

    return null;
  }, [isWindowsPathContext, mountedDriveSuggestions, normalizeResolvedPath, normalizedScopeBoundary]);

  const loadWindowsDriveSuggestions = React.useCallback(async (): Promise<FilesystemEntry[]> => {
    if (!isWindowsPathContext || normalizedScopeBoundary) {
      return [];
    }

    if (mountedDriveSuggestions) {
      return mountedDriveSuggestions;
    }

    return opencodeClient.listMountedDrives();
  }, [isWindowsPathContext, mountedDriveSuggestions, normalizedScopeBoundary]);

  React.useEffect(() => {
    if (!isWindowsPathContext || normalizedScopeBoundary) {
      setMountedDriveSuggestions(null);
      return;
    }

    let cancelled = false;
    void loadWindowsDriveSuggestions()
      .then((entries) => {
        if (!cancelled) {
          setMountedDriveSuggestions(entries);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMountedDriveSuggestions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isWindowsPathContext, loadWindowsDriveSuggestions, normalizedScopeBoundary]);

  const resolveInputContext = React.useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = normalizeResolvedPath(trimmed);
    const isDirectoryReference = trimmed === '~'
      || /^%userprofile%$/i.test(trimmed)
      || /[\\/]$/.test(trimmed)
      || /^[A-Za-z]:$/.test(trimmed)
      || /^\/[A-Za-z]$/.test(normalized);

    if (isDirectoryReference) {
      if (!isWithinScopeBoundary(normalized)) {
        return null;
      }

      return {
        directory: normalized,
        partialName: '',
        navigationParent: getParentDirectory(normalized),
      };
    }

    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) {
      return null;
    }

    const directory = lastSlash === 0 ? '/' : normalized.slice(0, lastSlash);
    if (!isWithinScopeBoundary(directory)) {
      return null;
    }

    return {
      directory,
      partialName: normalized.slice(lastSlash + 1),
      navigationParent: getParentDirectory(directory),
    };
  }, [getParentDirectory, isWithinScopeBoundary, normalizeResolvedPath]);

  const debouncedInputValue = useDebouncedValue(inputValue, 150);

  // Fetch directory suggestions
  React.useEffect(() => {
    if (!visible || !debouncedInputValue) {
      setSuggestions([]);
      setNavigationParentPath(null);
      setLoading(false);
      return;
    }

    const context = resolveInputContext(debouncedInputValue);
    if (!context) {
      setSuggestions([]);
      setNavigationParentPath(null);
      setLoading(false);
      return;
    }

    const { directory, partialName, navigationParent } = context;
    setNavigationParentPath(navigationParent);
    const suggestionLimit = !normalizedScopeBoundary && isWindowsPathContext && directory === '/'
      ? Math.max(mountedDriveSuggestions?.length ?? 0, 10)
      : 10;

    let cancelled = false;
    setLoading(true);

    const applySuggestions = (entries: FilesystemEntry[]) => {
      if (cancelled) {
        return;
      }

      const directories = entries.filter((entry) => {
        if (!entry.isDirectory) return false;
        if (!showHidden && entry.name.startsWith('.')) return false;
        if (!isWithinScopeBoundary(entry.path)) return false;
        return true;
      });

      const lowercasePartialName = partialName.toLowerCase();
      const scored = lowercasePartialName
        ? directories
            .map((entry) => {
              const score = fuzzyScore(lowercasePartialName, entry.name);
              return score !== null ? { entry, score } : null;
            })
            .filter((item): item is { entry: FilesystemEntry; score: number } => item !== null)
            .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
            .map((item) => item.entry)
        : directories.sort((a, b) => a.name.localeCompare(b.name));

      setSuggestions(scored.slice(0, suggestionLimit));
      setSelectedIndex(0);
    };

    if (!normalizedScopeBoundary && isWindowsPathContext && directory === '/') {
      void loadWindowsDriveSuggestions()
        .then((entries) => {
          applySuggestions(entries);
        })
        .catch(() => {
          if (!cancelled) {
            setSuggestions([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }

    opencodeClient.listLocalDirectory(toRequestPath(directory))
      .then((entries) => {
        applySuggestions(entries);
      })
      .catch(() => {
        if (!cancelled) {
          setSuggestions([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [visible, debouncedInputValue, resolveInputContext, toRequestPath, showHidden, fuzzyScore, isWithinScopeBoundary, normalizedScopeBoundary, isWindowsPathContext, loadWindowsDriveSuggestions, mountedDriveSuggestions?.length]);

  const items = React.useMemo<AutocompleteItem[]>(() => {
    const next: AutocompleteItem[] = [];
    if (navigationParentPath) {
      next.push({ kind: 'parent', path: navigationParentPath });
    }
    for (const entry of suggestions) {
      next.push({ kind: 'directory', entry });
    }
    return next;
  }, [navigationParentPath, suggestions]);

  React.useEffect(() => {
    if (items.length > 0 && selectedIndex >= items.length) {
      setSelectedIndex(0);
    }
  }, [items.length, selectedIndex]);

  // Scroll selected item into view
  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    });
  }, [selectedIndex]);

  // Handle outside click
  React.useEffect(() => {
    if (!visible) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) return;
      if (containerRef.current.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [visible, onClose]);

  const selectPath = React.useCallback((path: string) => {
    const normalized = normalizeResolvedPath(path);
    const pathWithTrailingSeparator = normalized.endsWith('/') ? normalized : `${normalized}/`;
    onSelectSuggestion(pathWithTrailingSeparator);
  }, [normalizeResolvedPath, onSelectSuggestion]);

  const handleSelectItem = React.useCallback((item: AutocompleteItem) => {
    const path = item.kind === 'parent' ? item.path : item.entry.path;
    selectPath(path);
  }, [selectPath]);

  // Expose key handler to parent
  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
      if (!visible || items.length === 0) {
        return false;
      }

      const total = items.length;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Tab: previous suggestion
          setSelectedIndex((prev) => (prev - 1 + total) % total);
        } else {
          // Tab: next suggestion or select if only one
          if (total === 1) {
            const selected = items[0];
            if (selected) {
              handleSelectItem(selected);
            }
          } else {
            setSelectedIndex((prev) => (prev + 1) % total);
          }
        }
        return true;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % total);
        return true;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + total) % total);
        return true;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        // Select current item and close autocomplete
        const safeIndex = ((selectedIndex % total) + total) % total;
        const selected = items[safeIndex];
        if (selected) {
          handleSelectItem(selected);
          if (selected.kind !== 'parent') {
            onClose();
          }
        }
        return true; // Consume the event, don't let parent confirm yet
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return true;
      }

      return false;
    }
  }), [visible, items, selectedIndex, handleSelectItem, onClose]);

  if (!visible || (items.length === 0 && !loading)) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] w-full max-h-48 bg-background border border-border rounded-lg shadow-none top-full mt-1 left-0 flex flex-col overflow-hidden"
    >
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <RiRefreshLine className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="overflow-y-auto py-1">
          {items.map((item, index) => {
            const isSelected = selectedIndex === index;
            const key = item.kind === 'parent' ? `parent:${item.path}` : item.entry.path;
            const label = item.kind === 'parent' ? '..' : item.entry.name;
            return (
              <div
                key={key}
                ref={(el) => { itemRefs.current[index] = el; }}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label',
                  isSelected && 'bg-interactive-selection'
                )}
                onClick={() => {
                  handleSelectItem(item);
                  if (item.kind !== 'parent') {
                    onClose();
                  }
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <RiFolderLine className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="truncate">{label}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="px-3 py-1.5 border-t typography-meta text-muted-foreground bg-sidebar/50">
        Tab cycle • ↑↓ navigate • Enter select
      </div>
    </div>
  );
});

DirectoryAutocomplete.displayName = 'DirectoryAutocomplete';
