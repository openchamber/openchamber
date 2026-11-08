import React from 'react';
import { createPortal } from 'react-dom';

import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { fixedPopupStyle, placeCaretPopup, samePlacement, viewportLimits, type CaretCoords } from './placement';

/** What a list hands its host: keys to move and choose, and whether it shows anything yet. */
export interface InlinePickerHandle {
  /** Until it answers true every key stays the field's; a list without it takes keys at once. */
  hasResults?: () => boolean;
  handleKeyDown: (key: string) => void;
}

/** A trigger being typed: where its sigil sits and the text after it. */
export type InlinePickerMatch = { from: number; query: string };

export type InlinePickerRenderProps = {
  ref: React.Ref<InlinePickerHandle>;
  query: string;
  style: React.CSSProperties;
  close: () => void;
  /** Write `text` over the trigger and its query, and close. */
  write: (text: string) => void;
};

/**
 * One kind of suggestion a text field offers while typing: emoji on `:`,
 * snippets on `#`. Adding one is a match rule and a list; opening, placement
 * at the caret, keys and writing the choice are the host's.
 */
export interface InlinePicker {
  id: string;
  /** The trigger before a collapsed caret at `caret`, or null. */
  match: (value: string, caret: number) => InlinePickerMatch | null;
  /** Only typing opens it: a paste, a drop or a caret move keep an open list in step or close it. */
  typedOnly?: boolean;
  /** The widest the list gets; a narrower field narrows it. */
  width: number;
  render: (props: InlinePickerRenderProps) => React.ReactNode;
}

const PICKER_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']);

type PickerKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>;

type OpenPicker = { picker: InlinePicker; match: InlinePickerMatch };

export type InlinePickerHost = {
  /** In order: where two match at once, the earlier one opens. Keep the array stable. */
  pickers: readonly InlinePicker[];
  getText: () => string;
  getCaret: () => number;
  /** Replace `[from, to)` with `insert` and leave the caret after it. */
  replaceRange: (from: number, to: number, insert: string) => void;
  /** Where the character at `position` is drawn, in viewport coordinates. */
  caretCoords: (position: number) => CaretCoords | null;
  /** The field's box, which the list stays within horizontally; the element `picker` is rendered in when absent. */
  getBounds?: () => DOMRect | null;
  /** Where the list is portalled; the body when absent. */
  portalTarget?: () => Element | null;
  rightToLeft?: boolean;
};

/**
 * The suggestions a text field offers while typing, placed at the caret: the
 * list rises right above the line being typed (or drops below it when there
 * is clearly more room), starting at the trigger, inside the field's width.
 * The host reports each text or caret change through `sync`, gives its
 * keydown to `handleKeyDown` first, and renders `picker` beside the field.
 * `useTextareaInlinePicker` does all three for a plain textarea.
 *
 * The list is portalled with fixed coordinates: fields sit in glass popovers
 * (a nested backdrop filter renders transparent), dialogs and panels that
 * clip, and near window edges.
 */
export function useInlinePicker(host: InlinePickerHost) {
  const { pickers, getText, getCaret, replaceRange, caretCoords, getBounds, portalTarget, rightToLeft = false } = host;
  const [open, setOpen] = React.useState<OpenPicker | null>(null);
  const [placement, setPlacement] = React.useState<ReturnType<typeof placeCaretPopup> | null>(null);
  const style = React.useMemo(() => (placement ? fixedPopupStyle(placement) : null), [placement]);
  const listRef = React.useRef<InlinePickerHandle>(null);
  const anchorRef = React.useRef<HTMLSpanElement>(null);

  const sync = React.useCallback((value: string, caret: number, typed = true) => {
    setOpen((current) => {
      for (const picker of pickers) {
        const match = picker.match(value, caret);
        if (!match) continue;
        if (picker.typedOnly && !typed && current?.picker !== picker) continue;
        return current?.picker === picker && current.match.from === match.from && current.match.query === match.query
          ? current
          : { picker, match };
      }
      return null;
    });
  }, [pickers]);

  const close = React.useCallback(() => setOpen(null), []);

  const from = open?.match.from ?? null;
  const query = open?.match.query ?? null;
  const width = open?.picker.width ?? 0;
  // Measured again as the query grows: it can wrap the trigger to the next line.
  React.useLayoutEffect(() => {
    if (from === null) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      // Anchored at the trigger, the list stays put while its query grows on one line.
      const caret = caretCoords(from);
      const bounds = getBounds?.() ?? anchorRef.current?.parentElement?.getBoundingClientRect() ?? null;
      if (!caret || !bounds) return;
      const caretBottom = caretCoords(getCaret())?.bottom ?? caret.bottom;
      const next = placeCaretPopup({ caret, caretBottom, bounds, limits: viewportLimits(), width, rightToLeft });
      // Scrolls anywhere land here; one that moved nothing re-renders nothing.
      setPlacement((current) => (samePlacement(current, next) ? current : next));
    };
    measure();
    // The phone's keyboard moves and pans the visual viewport, not the window.
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [caretCoords, from, getBounds, getCaret, query, rightToLeft, width]);

  const openRef = React.useRef(open);
  React.useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  const write = React.useCallback((text: string) => {
    const current = openRef.current;
    setOpen(null);
    if (!current) return;
    // Read the field again: text set from outside since the list opened
    // (dictation, a reset) or a selection made with it open is left alone.
    const caret = getCaret();
    const match = current.picker.match(getText(), caret);
    if (match) replaceRange(match.from, caret, text);
  }, [getCaret, getText, replaceRange]);

  /** True when the list took the key; the host must then ignore it. */
  const handleKeyDown = React.useCallback((event: PickerKeyEvent): boolean => {
    const list = listRef.current;
    if (!open || !list || list.hasResults?.() === false) return false;
    const key = getDropdownNavigationKey(event) ?? (PICKER_KEYS.has(event.key) && !event.shiftKey ? event.key : null);
    if (!key) return false;
    event.preventDefault();
    event.stopPropagation();
    list.handleKeyDown(key);
    return true;
  }, [open]);

  const picker = open === null ? null : (
    <>
      <span ref={anchorRef} aria-hidden="true" className="hidden" />
      {style ? createPortal(
        // The field's host may close on an outside press; a press in the list
        // belongs to the field, and must not move focus out of it.
        <div
          className="oc-inline-picker"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {open.picker.render({ ref: listRef, query: open.match.query, style, close, write })}
        </div>,
        portalTarget?.() ?? document.body,
      ) : null}
    </>
  );

  return { sync, close, handleKeyDown, picker, isOpen: open !== null };
}
