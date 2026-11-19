import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import type { Snippet } from '@/types/snippet';
import { findSnippetByTrigger, isValidSnippetName } from '@/lib/snippetNames';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { AutocompleteRowDetail } from './composer/ui/AutocompleteRowParts';
import { useHeightMorph } from '@/lib/motion/useSizeMorph';

export interface SnippetAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

interface SnippetAutocompleteProps {
  searchQuery: string;
  onSnippetSelect: (snippet: Snippet, trigger: string) => void;
  onClose: () => void;
  style?: React.CSSProperties;
  draftText?: string;
  onDraftSaved?: (typedName: string) => void;
}

interface PickerAction {
  id: string;
  label: string;
  icon: IconName;
  run: () => void;
}

function snippetPreview(snippet: Snippet): string {
  return (snippet.description || snippet.content).replace(/\s+/g, ' ').trim().slice(0, 120);
}

export const SnippetAutocomplete = React.forwardRef<SnippetAutocompleteHandle, SnippetAutocompleteProps>(({
  searchQuery,
  onSnippetSelect,
  onClose,
  style,
  draftText,
  onDraftSaved,
}, ref) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  useHeightMorph(containerRef);
  const isMobile = useUIStore((state) => state.isMobile);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, style?.maxHeight === undefined, 240);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const snippets = useSnippetsStore((s) => s.snippets);
  const loadSnippets = useSnippetsStore((s) => s.loadSnippets);
  const openQuickCreate = useSnippetsStore((s) => s.openQuickCreate);

  React.useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  const query = searchQuery.trim();
  const filteredSnippets = React.useMemo(() => {
    const matches = query.length
      ? snippets.filter((snippet) => fuzzyMatch(snippet.name, query) || snippet.aliases.some((alias) => fuzzyMatch(alias, query)))
      : snippets;
    return [...matches].sort((a, b) => {
      if (a.source === 'project' && b.source !== 'project') return -1;
      if (a.source !== 'project' && b.source === 'project') return 1;
      return a.name.localeCompare(b.name);
    });
  }, [query, snippets]);

  const actions = React.useMemo((): PickerAction[] => {
    const create = (request: Parameters<typeof openQuickCreate>[0]) => () => {
      openQuickCreate(request);
      onClose();
    };
    const typedName = isValidSnippetName(query) && !findSnippetByTrigger(snippets, query) ? query : null;
    if (!typedName) {
      return [{ id: 'new', label: t('chat.snippetAutocomplete.action.addNew'), icon: 'add', run: create({ content: '' }) }];
    }
    const typedActions: PickerAction[] = [];
    const draft = draftText?.trim() ?? '';
    if (draft) {
      typedActions.push({
        id: 'save-draft',
        label: t('chat.snippetAutocomplete.action.saveDraft', { name: typedName }),
        icon: 'save-3',
        run: create({ name: typedName, content: draft, onSaved: onDraftSaved ? () => onDraftSaved(typedName) : undefined }),
      });
    }
    typedActions.push({ id: 'create', label: t('chat.snippetAutocomplete.action.create', { name: typedName }), icon: 'add', run: create({ name: typedName, content: '' }) });
    return typedActions;
  }, [draftText, onClose, onDraftSaved, openQuickCreate, query, snippets, t]);

  React.useEffect(() => {
    setSelectedIndex(filteredSnippets.length ? actions.length : 0);
  }, [actions.length, filteredSnippets]);

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
    const trigger = snippet.aliases.includes(query) ? query : snippet.name;
    onSnippetSelect(snippet, trigger);
  }, [onSnippetSelect, query]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }
      const itemCount = actions.length + filteredSnippets.length;
      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % itemCount);
        return;
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + itemCount) % itemCount);
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        const index = selectedIndexRef.current;
        if (index < actions.length) {
          actions[index]?.run();
          return;
        }
        const snippet = filteredSnippets[index - actions.length];
        if (snippet) chooseSnippet(snippet);
      }
    },
  }), [actions, chooseSnippet, filteredSnippets, onClose]);

  return (
    <div ref={containerRef} className="absolute z-[100] min-w-0 w-full max-w-[420px] max-h-64 oc-glass-popover oc-glass-floating rounded-xl bottom-full mb-2 inset-s-0 flex flex-col" style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}>
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="p-1">
        {actions.map((action, index) => (
          <div
            key={action.id}
            ref={(el) => { itemRefs.current[index] = el; }}
            className={cn('flex min-w-0 items-center gap-2 px-2 py-1.5 cursor-pointer rounded-lg typography-ui-label', selectedIndex === index && 'bg-interactive-selection')}
            onClick={action.run}
            onMouseMove={() => setSelectedIndex(index)}
          >
            <Icon name={action.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{action.label}</span>
          </div>
        ))}
        {filteredSnippets.length ? filteredSnippets.map((snippet, index) => {
          const itemIndex = actions.length + index;
          return (
            <div
              key={`${snippet.source}:${snippet.filePath}`}
              ref={(el) => { itemRefs.current[itemIndex] = el; }}
              className={cn('flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-lg typography-ui-label', itemIndex === selectedIndex && 'bg-interactive-selection')}
              onClick={() => chooseSnippet(snippet)}
              onMouseMove={() => setSelectedIndex(itemIndex)}
            >
              <span className="max-w-[60%] shrink-0 truncate font-semibold">#{snippet.name}</span>
              <AutocompleteRowDetail scope={snippet.source === 'project' ? 'project' : 'user'} description={snippetPreview(snippet)} />
            </div>
          );
        }) : (
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
