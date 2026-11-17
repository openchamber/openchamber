import React from 'react';
import { createPortal } from 'react-dom';

import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { fixedPopupStyle, placeCaretPopup, samePlacement, viewportLimits, type CaretCoords } from './placement';

export interface InlinePickerHandle {
  hasResults?: () => boolean;
  handleKeyDown: (key: string) => void;
}

export type InlinePickerMatch = { from: number; query: string };

export type InlinePickerRenderProps = {
  ref: React.Ref<InlinePickerHandle>;
  query: string;
  style: React.CSSProperties;
  close: () => void;
  write: (text: string) => void;
};

export interface InlinePicker {
  id: string;
  match: (value: string, caret: number) => InlinePickerMatch | null;
  typedOnly?: boolean;
  width: number;
  render: (props: InlinePickerRenderProps) => React.ReactNode;
}

const PICKER_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']);

type PickerKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>;

type OpenPicker = { picker: InlinePicker; match: InlinePickerMatch };

export type InlinePickerHost = {
  pickers: readonly InlinePicker[];
  getText: () => string;
  getCaret: () => number;
  replaceRange: (from: number, to: number, insert: string) => void;
  caretCoords: (position: number) => CaretCoords | null;
  getBounds?: () => DOMRect | null;
  portalTarget?: () => Element | null;
  rightToLeft?: boolean;
};

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
  React.useLayoutEffect(() => {
    if (from === null) {
      setPlacement(null);
      return;
    }
    const measure = () => {
      const caret = caretCoords(from);
      const bounds = getBounds?.() ?? anchorRef.current?.parentElement?.getBoundingClientRect() ?? null;
      if (!caret || !bounds) return;
      const caretBottom = caretCoords(getCaret())?.bottom ?? caret.bottom;
      const next = placeCaretPopup({ caret, caretBottom, bounds, limits: viewportLimits(), width, rightToLeft });
      setPlacement((current) => (samePlacement(current, next) ? current : next));
    };
    measure();
    // external: https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API The phone's keyboard can resize and pan the visual viewport without resizing the window.
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
    const caret = getCaret();
    const match = current.picker.match(getText(), caret);
    if (match) replaceRange(match.from, caret, text);
  }, [getCaret, getText, replaceRange]);

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
