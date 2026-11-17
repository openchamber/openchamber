import type * as React from 'react';
import { readMobileKeyboardVar } from '@/lib/mobileKeyboardInsets';

export type CaretCoords = { top: number; bottom: number; left: number };

type CaretPopupPlacement = {
  left: number;
  top: number;
  place: 'above' | 'below';
  width: number;
  maxHeight: number;
};

type PopupLimits = { top: number; bottom: number };

const GAP_PX = 6;
const EDGE_PX = 8;
const MIN_HEIGHT_PX = 120;
const PREFERRED_HEIGHT_PX = 260;
const TEXT_INSET_PX = 12;

export const placeCaretPopup = ({
  caret,
  caretBottom = caret.bottom,
  bounds,
  limits,
  width,
  rightToLeft = false,
}: {
  caret: CaretCoords;
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

export const samePlacement = (a: CaretPopupPlacement | null, b: CaretPopupPlacement): boolean => (
  a !== null && a.left === b.left && a.top === b.top && a.place === b.place && a.width === b.width && a.maxHeight === b.maxHeight
);

export const fixedPopupStyle = (placement: CaretPopupPlacement): React.CSSProperties => ({
  position: 'fixed',
  left: placement.left,
  right: 'auto',
  width: placement.width,
  maxWidth: placement.width,
  maxHeight: placement.maxHeight,
  marginBottom: 0,
  ...(placement.place === 'above'
    ? { top: 'auto', bottom: window.innerHeight - placement.top }
    : { top: placement.top, bottom: 'auto' }),
});

export const viewportLimits = (): PopupLimits => {
  const top = window.visualViewport?.offsetTop ?? 0;
  const keyboard = readMobileKeyboardVar('--oc-keyboard-inset');
  return {
    top,
    bottom: Math.min(top + (window.visualViewport?.height ?? window.innerHeight), window.innerHeight - keyboard),
  };
};

const MIRRORED_STYLES = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform',
  'wordSpacing', 'tabSize', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap', 'direction', 'textAlign',
] as const;

export const textareaCaretCoords = (field: HTMLTextAreaElement, position = field.selectionStart): CaretCoords => {
  const box = field.getBoundingClientRect();
  const style = window.getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const key of MIRRORED_STYLES) mirror.style[key] = style[key];
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
