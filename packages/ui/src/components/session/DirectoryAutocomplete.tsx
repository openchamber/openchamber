import React from 'react';
import { RiFolderLine, RiRefreshLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { opencodeClient, type FilesystemEntry } from '@/lib/opencode/client';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

interface DirectoryAutocompleteProps {
  inputValue: string;
  homeDirectory: string | null;
  onSelectSuggestion: (path: string) => void;
  visible: boolean;
  onClose: () => void;
  showHidden: boolean;
}

export interface DirectoryAutocompleteHandle {
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean;
}

export const DirectoryAutocomplete = React.forwardRef<DirectoryAutocompleteHandle, DirectoryAutocompleteProps>(({
  inputValue,
  homeDirectory,
  onSelectSuggestion,
  visible,
  onClose,
  showHidden,
}, ref) => {
  const [suggestions, setSuggestions] = React.useState<FilesystemEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
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
    if (path.startsWith('~') && homeDirectory) {
      return path.replace(/^~/, homeDirectory);
    }
    return path;
  }, [homeDirectory]);

  // Get the directory part of the path for listing
  const getParentDir = React.useCallback((path: string): string => {
    const expanded = expandPath(path);
    // If ends with /, list that directory
    if (expanded.endsWith('/')) {
      return expanded;
    }
    // Otherwise, get parent directory
    const lastSlash = expanded.lastIndexOf('/');
    if (lastSlash === -1) return '';
    if (lastSlash === 0) return '/';
    return expanded.substring(0, lastSlash + 1);
  }, [expandPath]);

  // Get the partial name being typed (for filtering)
  const getPartialName = React.useCallback((path: string): string => {
    const expanded = expandPath(path);
    if (expanded.endsWith('/')) return '';
    const lastSlash = expanded.lastIndexOf('/');
    if (lastSlash === -1) return expanded;
    return expanded.substring(lastSlash + 1);
  }, [expandPath]);

  const debouncedInputValue = useDebouncedValue(inputValue, 150);

  // Fetch directory suggestions
  React.useEffect(() => {
    if (!visible || !debouncedInputValue) {
      setSuggestions([]);
      return;
    }

    const parentDir = getParentDir(debouncedInputValue);
    const partialName = getPartialName(debouncedInputValue).toLowerCase();

    if (!parentDir) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    opencodeClient.listLocalDirectory(parentDir)
      .then((entries) => {
        if (cancelled) return;
        
        // Filter to directories only, respect hidden setting
        const directories = entries.filter((entry) => {
          if (!entry.isDirectory) return false;
          if (!showHidden && entry.name.startsWith('.')) return false;
          return true;
        });

        // Apply fuzzy matching and sort by score
        const scored = partialName
          ? directories
              .map((entry) => {
                const score = fuzzyScore(partialName, entry.name);
                return score !== null ? { entry, score } : null;
              })
              .filter((item): item is { entry: FilesystemEntry; score: number } => item !== null)
              .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
              .map((item) => item.entry)
          : directories.sort((a, b) => a.name.localeCompare(b.name));

        setSuggestions(scored.slice(0, 10)); // Limit suggestions
        setSelectedIndex(0);
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
  }, [visible, debouncedInputValue, getParentDir, getPartialName, showHidden, fuzzyScore]);

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

  const handleSelectSuggestion = React.useCallback((entry: FilesystemEntry) => {
    // Append the selected directory name to current path, with trailing slash
    const path = entry.path.endsWith('/') ? entry.path : entry.path + '/';
    onSelectSuggestion(path);
  }, [onSelectSuggestion]);

  // Expose key handler to parent
  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
      if (!visible || suggestions.length === 0) {
        return false;
      }

      const total = suggestions.length;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Tab: previous suggestion
          setSelectedIndex((prev) => (prev - 1 + total) % total);
        } else {
          // Tab: next suggestion or select if only one
          if (total === 1) {
            const selected = suggestions[0];
            if (selected) {
              handleSelectSuggestion(selected);
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
        const selected = suggestions[safeIndex];
        if (selected) {
          handleSelectSuggestion(selected);
        }
        onClose();
        return true; // Consume the event, don't let parent confirm yet
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return true;
      }

      return false;
    }
  }), [visible, suggestions, selectedIndex, handleSelectSuggestion, onClose]);

  if (!visible || (suggestions.length === 0 && !loading)) {
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
          {suggestions.map((entry, index) => {
            const isSelected = selectedIndex === index;
            return (
              <div
                key={entry.path}
                ref={(el) => { itemRefs.current[index] = el; }}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label",
                  isSelected && "bg-interactive-selection"
                )}
                onClick={() => { handleSelectSuggestion(entry); onClose(); }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <RiFolderLine className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="truncate">{entry.name}</span>
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
