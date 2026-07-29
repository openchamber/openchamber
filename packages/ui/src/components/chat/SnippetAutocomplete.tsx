import React from 'react';
import { cn } from '@/lib/utils';
import { rankAutocompleteItems } from '@/lib/search/autocompleteRanking';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { Snippet } from '@/types/snippet';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';

export interface SnippetAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

interface SnippetAutocompleteProps {
  searchQuery: string;
  onSnippetSelect: (snippet: Snippet, trigger: string) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

function snippetPreview(snippet: Snippet): string {
  return (snippet.description || snippet.content).replace(/\s+/g, ' ').trim().slice(0, 120);
}

export const SnippetAutocomplete = React.forwardRef<SnippetAutocompleteHandle, SnippetAutocompleteProps>(({
  searchQuery,
  onSnippetSelect,
  onClose,
  style,
}, ref) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const isMobile = useUIStore((state) => state.isMobile);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const [filteredSnippets, setFilteredSnippets] = React.useState<Snippet[]>([]);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const snippets = useSnippetsStore((s) => s.snippets);
  const loadSnippets = useSnippetsStore((s) => s.loadSnippets);
  const setSnippetDraft = useSnippetsStore((s) => s.setSnippetDraft);
  const setSelectedSnippet = useSnippetsStore((s) => s.setSelectedSnippet);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);

  React.useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  React.useEffect(() => {
    const filtered = rankAutocompleteItems(
      snippets,
      searchQuery,
      (snippet) => `${snippet.name} ${snippet.aliases.join(' ')}`,
      {
        compare: (a, b) => {
          if (a.source === 'project' && b.source !== 'project') return -1;
          if (a.source !== 'project' && b.source === 'project') return 1;
          return a.name.localeCompare(b.name);
        },
      },
    );
    setFilteredSnippets(filtered);
    setSelectedIndex(filtered.length ? 1 : 0);
  }, [searchQuery, snippets]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  const chooseSnippet = React.useCallback((snippet: Snippet) => {
    const query = searchQuery.trim();
    const trigger = snippet.aliases.includes(query) ? query : snippet.name;
    onSnippetSelect(snippet, trigger);
  }, [onSnippetSelect, searchQuery]);

  const openNewSnippetSettings = React.useCallback(() => {
    const existing = new Set(snippets.map((snippet) => snippet.name));
    let name = 'new-snippet';
    let counter = 1;
    while (existing.has(name)) {
      name = `new-snippet-${counter++}`;
    }
    setSnippetDraft({ name, scope: 'global' });
    setSelectedSnippet(name);
    setSettingsPage('snippets');
    setSettingsDialogOpen(true);
    onClose();
  }, [onClose, setSelectedSnippet, setSettingsDialogOpen, setSettingsPage, setSnippetDraft, snippets]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }
      const itemCount = filteredSnippets.length + 1;
      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % itemCount);
        return;
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + itemCount) % itemCount);
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        if (selectedIndexRef.current === 0) {
          openNewSnippetSettings();
          return;
        }
        const snippet = filteredSnippets[selectedIndexRef.current - 1];
        if (snippet) chooseSnippet(snippet);
      }
    },
  }), [chooseSnippet, filteredSnippets, onClose, openNewSnippetSettings]);

  return (
    <div ref={containerRef} className="absolute z-[100] min-w-0 w-full max-w-[450px] max-h-60 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col" style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}>
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        <div
          ref={(el) => { itemRefs.current[0] = el; }}
          className={cn('flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label', selectedIndex === 0 && 'bg-interactive-selection')}
          onClick={openNewSnippetSettings}
          onMouseMove={() => setSelectedIndex(0)}
        >
          <Icon name="add" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">{t('chat.snippetAutocomplete.action.addNew')}</span>
        </div>
        {filteredSnippets.length ? filteredSnippets.map((snippet, index) => (
          <div
            key={`${snippet.source}:${snippet.filePath}`}
            ref={(el) => { itemRefs.current[index + 1] = el; }}
            className={cn('flex gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label', isMobile ? 'items-center' : 'items-start', index + 1 === selectedIndex && 'bg-interactive-selection')}
            onClick={() => chooseSnippet(snippet)}
            onMouseMove={() => setSelectedIndex(index + 1)}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold truncate">#{snippet.name}</span>
                <span className="text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60">{t(`snippets.source.${snippet.source}`)}</span>
              </div>
              {!isMobile && (
                <div className="typography-meta text-muted-foreground mt-0.5 truncate">{snippetPreview(snippet)}</div>
              )}
            </div>
          </div>
        )) : (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">{t('chat.snippetAutocomplete.empty')}</div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">{t('chat.snippetAutocomplete.footer')}</div>
      )}
    </div>
  );
});

SnippetAutocomplete.displayName = 'SnippetAutocomplete';
