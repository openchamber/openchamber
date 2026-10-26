import React from 'react';

import type { InlinePickerHandle } from '@/components/inline-picker/useInlinePicker';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { searchEmoji, useEmojiTable, type EmojiEntry } from '@/lib/emoji/shortcodes';
import { cn } from '@/lib/utils';
import { useMobileAutocompleteMaxHeight } from '@/components/chat/useMobileAutocompleteMaxHeight';

/** `hasResults` is always given: until a list is on screen every key stays the field's. */
export type EmojiAutocompleteHandle = InlinePickerHandle;

interface EmojiAutocompleteProps {
  searchQuery: string;
  onEmojiSelect: (emoji: string) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

const RESULT_LIMIT = 40;

/**
 * The emoji a `:query` finds, for the composer and every text field
 * (`emojiInlinePicker`). Hosts hand it keys only while `hasResults()`; with
 * nothing found, or a table that could not load, it closes, so the key that
 * would have chosen one does what the field does with it.
 */
export const EmojiAutocomplete = React.forwardRef<EmojiAutocompleteHandle, EmojiAutocompleteProps>(({
  searchQuery,
  onEmojiSelect,
  onClose,
  style,
}, ref) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, true, 240);
  const { table, failed } = useEmojiTable(true);
  const results = React.useMemo<EmojiEntry[]>(
    () => (table ? searchEmoji(table.entries, searchQuery, RESULT_LIMIT) : []),
    [searchQuery, table],
  );
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  React.useEffect(() => setSelectedIndex(0), [results]);
  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);
  React.useEffect(() => {
    if ((table && results.length === 0) || failed) onClose();
  }, [failed, onClose, results.length, table]);

  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && containerRef.current && !containerRef.current.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  React.useImperativeHandle(ref, () => ({
    hasResults: () => results.length > 0,
    handleKeyDown: (key: string) => {
      if (key === 'Escape' || results.length === 0) {
        onClose();
        return;
      }
      if (key === 'ArrowDown') setSelectedIndex((index) => (index + 1) % results.length);
      else if (key === 'ArrowUp') setSelectedIndex((index) => (index - 1 + results.length) % results.length);
      else if (key === 'Enter' || key === 'Tab') {
        const entry = results[selectedIndex];
        if (entry) onEmojiSelect(entry.emoji);
      }
    },
  }), [onClose, onEmojiSelect, results, selectedIndex]);

  if (results.length === 0) return null;
  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[280px] max-h-64 oc-glass-popover oc-glass-floating rounded-xl bottom-full mb-2 inset-s-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="p-1">
        {results.map((entry, index) => (
          <div
            key={entry.emoji}
            ref={(el) => { itemRefs.current[index] = el; }}
            className={cn('flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-lg typography-ui-label', index === selectedIndex && 'bg-interactive-selection')}
            onClick={() => onEmojiSelect(entry.emoji)}
            onMouseMove={() => setSelectedIndex(index)}
          >
            <span className="w-5 shrink-0 text-center text-base leading-none">{entry.emoji}</span>
            <span className="min-w-0 truncate text-foreground">:{entry.names[0]}:</span>
          </div>
        ))}
      </ScrollableOverlay>
    </div>
  );
});

EmojiAutocomplete.displayName = 'EmojiAutocomplete';
