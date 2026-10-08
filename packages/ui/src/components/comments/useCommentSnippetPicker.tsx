import React from 'react';
import { createPortal } from 'react-dom';

import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '@/components/chat/SnippetAutocomplete';
import { matchSnippetTrigger } from '@/components/chat/composer/language/triggers';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import type { Snippet } from '@/types/snippet';

const PICKER_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']);

const PICKER_GAP_PX = 6;
const PICKER_EDGE_PX = 8;
const PICKER_MAX_HEIGHT_PX = 240;
const PICKER_MAX_WIDTH_PX = 450;

/**
 * Where the picker goes for a field at `rect`: above when there is room for it
 * (or more room than below), otherwise below, never past the window edge.
 */
const placePicker = (rect: DOMRect): React.CSSProperties => {
  const spaceAbove = rect.top - PICKER_GAP_PX - PICKER_EDGE_PX;
  const spaceBelow = window.innerHeight - rect.bottom - PICKER_GAP_PX - PICKER_EDGE_PX;
  const above = spaceAbove >= PICKER_MAX_HEIGHT_PX || spaceAbove >= spaceBelow;
  const width = Math.min(rect.width, PICKER_MAX_WIDTH_PX, window.innerWidth - 2 * PICKER_EDGE_PX);
  return {
    position: 'fixed',
    left: Math.max(PICKER_EDGE_PX, Math.min(rect.left, window.innerWidth - width - PICKER_EDGE_PX)),
    width,
    maxWidth: width,
    marginBottom: 0,
    maxHeight: Math.max(80, Math.min(PICKER_MAX_HEIGHT_PX, above ? spaceAbove : spaceBelow)),
    ...(above
      ? { top: 'auto', bottom: window.innerHeight - rect.top + PICKER_GAP_PX }
      : { top: rect.bottom + PICKER_GAP_PX, bottom: 'auto' }),
  };
};

type PickerKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>;

/**
 * The composer's `#snippet` picker for a comment field. The host reports every
 * text or caret change through `sync`, gives its keydown to `handleKeyDown`
 * first, and renders `picker` inside the field's wrapper. The list itself is
 * portalled to the body with a fixed position: comment fields sit in glass
 * popovers (a nested backdrop filter renders transparent) and near window
 * edges, so it opens above or below the wrapper, wherever it fits. Choosing a snippet writes `#trigger ` over the typed query, the way
 * the composer does; expansion happens when the message is sent.
 */
export function useCommentSnippetPicker({
  text,
  getCaret,
  replaceRange,
}: {
  text: string;
  getCaret: () => number;
  /** Replace `[from, to)` with `insert` and leave the caret after it. */
  replaceRange: (from: number, to: number, insert: string) => void;
}) {
  const [query, setQuery] = React.useState<string | null>(null);
  const pickerRef = React.useRef<SnippetAutocompleteHandle>(null);
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = React.useState<React.CSSProperties | null>(null);
  const isOpen = query !== null;

  React.useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const field = anchorRef.current?.parentElement;
      if (field) setPlacement(placePicker(field.getBoundingClientRect()));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [isOpen]);

  const sync = React.useCallback((value: string, caret: number) => {
    setQuery(matchSnippetTrigger(value, caret));
  }, []);

  const close = React.useCallback(() => setQuery(null), []);

  const select = React.useCallback((_snippet: Snippet, trigger: string) => {
    const caret = getCaret();
    const hashIndex = text.slice(0, caret).lastIndexOf('#');
    replaceRange(hashIndex === -1 ? caret : hashIndex, caret, `#${trigger} `);
    setQuery(null);
  }, [getCaret, replaceRange, text]);

  /** True when the picker took the key; the host must then ignore it. */
  const handleKeyDown = React.useCallback((event: PickerKeyEvent): boolean => {
    if (query === null || !pickerRef.current) return false;
    const key = getDropdownNavigationKey(event) ?? (PICKER_KEYS.has(event.key) && !event.shiftKey ? event.key : null);
    if (!key) return false;
    event.preventDefault();
    event.stopPropagation();
    pickerRef.current.handleKeyDown(key);
    return true;
  }, [query]);

  const picker = query === null ? null : (
    <>
      <span ref={anchorRef} aria-hidden="true" className="hidden" />
      {placement ? createPortal(
        // The comment hosts close on an outside press; a press in the list
        // belongs to the comment, and must not move focus out of its field.
        <div
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <SnippetAutocomplete
            ref={pickerRef}
            searchQuery={query}
            onSnippetSelect={select}
            onClose={close}
            style={placement}
          />
        </div>,
        document.body,
      ) : null}
    </>
  );

  return { sync, close, handleKeyDown, picker };
}
