import type * as React from 'react';

/** A caret in viewport coordinates: the top and bottom of its line, and its x. */
export type CaretCoords = { top: number; bottom: number; left: number };

/** Where a caret popup goes, in viewport coordinates. `above`: `top` is the popup's bottom edge. */
type CaretPopupPlacement = {
  left: number;
  top: number;
  place: 'above' | 'below';
  width: number;
  maxHeight: number;
};

/**
 * The vertical room a popup may take, in viewport coordinates. `bottom` is
 * what the user can see: above the phone's keyboard, which covers the page
 * without shrinking it.
 */
type PopupLimits = { top: number; bottom: number };

const GAP_PX = 6;
const EDGE_PX = 8;
const MIN_HEIGHT_PX = 120;
const PREFERRED_HEIGHT_PX = 260;
// The list's rows start their text this far in, so the typed sigil and the
// names under it line up.
const TEXT_INSET_PX = 12;

/**
 * A popup for what is being typed at `caret`, the trigger: right above its
 * line, or below the line the caret is on now (`caretBottom`) when the room
 * above is short of its full height and less than the room below, as near
 * the top of the screen. It starts at the trigger and runs along the line's
 * direction, shifted back where it would leave `bounds`, the field it belongs
 * to. `limits` is the vertical room it may take, which can reach past the
 * field: over the transcript above a composer, for instance.
 */
export const placeCaretPopup = ({
  caret,
  caretBottom = caret.bottom,
  bounds,
  limits,
  width,
  rightToLeft = false,
}: {
  caret: CaretCoords;
  /** The bottom of the line the caret is on now, below a trigger whose query wrapped. */
  caretBottom?: number;
  bounds: { left: number; right: number };
  limits: PopupLimits;
  width: number;
  rightToLeft?: boolean;
}): CaretPopupPlacement => {
  const spaceAbove = caret.top - GAP_PX - limits.top - EDGE_PX;
  const spaceBelow = limits.bottom - caretBottom - GAP_PX - EDGE_PX;
  const place = spaceAbove >= PREFERRED_HEIGHT_PX || spaceAbove >= spaceBelow ? 'above' : 'below';
  const fitted = Math.max(0, Math.min(width, bounds.right - bounds.left));
  const start = rightToLeft ? caret.left + TEXT_INSET_PX - fitted : caret.left - TEXT_INSET_PX;
  return {
    left: Math.max(bounds.left, Math.min(start, bounds.right - fitted)),
    top: place === 'above' ? caret.top - GAP_PX : caretBottom + GAP_PX,
    place,
    width: fitted,
    maxHeight: Math.max(MIN_HEIGHT_PX, Math.min(PREFERRED_HEIGHT_PX, place === 'above' ? spaceAbove : spaceBelow)),
  };
};

/** Two placements that put the popup in the same spot. */
export const samePlacement = (a: CaretPopupPlacement | null, b: CaretPopupPlacement): boolean => (
  a !== null && a.left === b.left && a.top === b.top && a.place === b.place && a.width === b.width && a.maxHeight === b.maxHeight
);

/** The placement as fixed-position styles for a popup portalled out of its field. */
export const fixedPopupStyle = (placement: CaretPopupPlacement): React.CSSProperties => ({
  position: 'fixed',
  left: placement.left,
  // The lists carry `inset-s-0`, which right to left is `right: 0` and would win over `left`.
  right: 'auto',
  width: placement.width,
  maxWidth: placement.width,
  maxHeight: placement.maxHeight,
  marginBottom: 0,
  ...(placement.place === 'above'
    ? { top: 'auto', bottom: window.innerHeight - placement.top }
    : { top: placement.top, bottom: 'auto' }),
});

/**
 * The part of the window the user sees, above the phone's keyboard. A mobile
 * browser reports the keyboard through the visual viewport. The iOS app does
 * not: its keyboard overlays a full-height view and the app lifts its UI by
 * `--oc-keyboard-inset` (`apps/mobileNativeChrome.ts`), so that inset ends the
 * room there.
 */
export const viewportLimits = (): PopupLimits => {
  const top = window.visualViewport?.offsetTop ?? 0;
  const keyboard = Number.parseFloat(document.documentElement.style.getPropertyValue('--oc-keyboard-inset')) || 0;
  return {
    top,
    bottom: Math.min(top + (window.visualViewport?.height ?? window.innerHeight), window.innerHeight - keyboard),
  };
};

// What decides where a textarea's text wraps, copied onto the measuring box.
const MIRRORED_STYLES = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
  'wordSpacing', 'tabSize', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap', 'direction', 'textAlign',
] as const;

/**
 * Where the character at `position` (the selection's start by default) is
 * drawn in a textarea, which, unlike an editor, cannot say. Measured on an
 * off-screen copy laid out with the field's own wrapping and text width: the
 * text before it, then the rest of its word in a marker, so a word the field
 * wraps to the next line is measured there too. Kept inside the field's
 * visible part.
 */
export const textareaCaretCoords = (field: HTMLTextAreaElement, position = field.selectionStart): CaretCoords => {
  const box = field.getBoundingClientRect();
  const style = window.getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const key of MIRRORED_STYLES) mirror.style[key] = style[key];
  // The field's text width, without a scrollbar it may show.
  const borders = (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.borderRightWidth) || 0);
  Object.assign(mirror.style, {
    position: 'fixed', top: '0', left: '-10000px', visibility: 'hidden', overflow: 'hidden', height: 'auto',
    boxSizing: 'border-box', width: `${field.clientWidth + borders}px`,
  });
  mirror.textContent = field.value.slice(0, position);
  const word = /^\S*/.exec(field.value.slice(position))?.[0] ?? '';
  const marker = document.createElement('span');
  marker.textContent = word || '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  const mirrorBox = mirror.getBoundingClientRect();
  const first = marker.getClientRects()[0] ?? marker.getBoundingClientRect();
  const lineHeight = Math.min(first.height || Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 16, box.height);
  const offsetTop = first.top - mirrorBox.top;
  const offsetLeft = (style.direction === 'rtl' ? first.right : first.left) - mirrorBox.left;
  mirror.remove();
  const top = Math.max(box.top, Math.min(box.top + offsetTop - field.scrollTop, box.bottom - lineHeight));
  const left = Math.max(box.left, Math.min(box.left + offsetLeft - field.scrollLeft, box.right));
  return { top, bottom: top + lineHeight, left };
};
