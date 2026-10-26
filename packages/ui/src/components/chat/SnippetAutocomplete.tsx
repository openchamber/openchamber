import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { Snippet } from '@/types/snippet';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { AutocompleteRowDetail } from './composer/ui/AutocompleteRowParts';

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
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, true, 240);
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
    const query = searchQuery.trim();
    const matches = query.length
      ? snippets.filter((snippet) => fuzzyMatch(snippet.name, query) || snippet.aliases.some((alias) => fuzzyMatch(alias, query)))
      : snippets;
    const sortedMatches = [...matches].sort((a, b) => {
      if (a.source === 'project' && b.source !== 'project') return -1;
      if (a.source !== 'project' && b.source === 'project') return 1;
      return a.name.localeCompare(b.name);
    });
    setFilteredSnippets(sortedMatches);
    setSelectedIndex(sortedMatches.length ? 1 : 0);
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
    <div ref={containerRef} className="absolute z-[100] min-w-0 w-full max-w-[420px] max-h-64 oc-glass-popover oc-glass-floating rounded-xl bottom-full mb-2 inset-s-0 flex flex-col" style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}>
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="p-1">
        <div
          ref={(el) => { itemRefs.current[0] = el; }}
          className={cn('flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-lg typography-ui-label', selectedIndex === 0 && 'bg-interactive-selection')}
          onClick={openNewSnippetSettings}
          onMouseMove={() => setSelectedIndex(0)}
        >
          <Icon name="add" className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{t('chat.snippetAutocomplete.action.addNew')}</span>
        </div>
        {filteredSnippets.length ? filteredSnippets.map((snippet, index) => (
          <div
            key={`${snippet.source}:${snippet.filePath}`}
            ref={(el) => { itemRefs.current[index + 1] = el; }}
            className={cn('flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-lg typography-ui-label', index + 1 === selectedIndex && 'bg-interactive-selection')}
            onClick={() => chooseSnippet(snippet)}
            onMouseMove={() => setSelectedIndex(index + 1)}
          >
            <span className="max-w-[60%] shrink-0 truncate font-semibold">#{snippet.name}</span>
            {/* A global snippet is the user's own, as a user skill or command is. */}
            <AutocompleteRowDetail scope={snippet.source === 'project' ? 'project' : 'user'} description={snippetPreview(snippet)} />
          </div>
        )) : (
          <div className="px-2 py-1.5 typography-ui-label text-muted-foreground">{t('chat.snippetAutocomplete.empty')}</div>
        )}
      </ScrollableOverlay>
      {!isMobile && (
        <div className="px-3 py-1.5 border-t typography-meta text-muted-foreground">{t('chat.snippetAutocomplete.footer')}</div>
      )}
    </div>
  );
});

SnippetAutocomplete.displayName = 'SnippetAutocomplete';
