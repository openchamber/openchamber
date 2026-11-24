import { prefersReducedMotion } from '@/lib/layoutAnimation';
import { requestMessageFocus } from '@/lib/router/messageFocus';
import { onNextFrame } from '@/lib/timing/onNextFrame';

import { createFollowGlide, drawsScrollInWholePixels } from '../lib/scroll/followGlide';
import { messageLinkOffsetTop } from '../lib/scroll/messageViewportAnchor';
import { dispatchNavigationRelease } from '../lib/scroll/timelineScrollIntent';
import { findTermRanges } from './chatSearchHighlight';

const COMPOSER_GAP_PX = 12;
const ADJACENT_ROW_PX = 2;
const SCROLLER_INPUT_EVENTS = ['wheel', 'openchamber:frame-scroll'];
const PAGE_INPUT_EVENTS = ['pointerdown', 'keydown'];

type Span = { readonly top: number; readonly bottom: number };

export const resolveMatchScrollTarget = (match: Span, scroll: number, band: Span, maxScroll: number): number | null => {
  if (match.top >= scroll + band.top && match.bottom <= scroll + band.bottom) return null;
  const target = Math.min(maxScroll, Math.max(0, (match.top + match.bottom - band.top - band.bottom) / 2));
  return Math.abs(target - scroll) <= 1 ? null : target;
};

export const searchRowIdentity = (row: Element): string => (
  row.getAttribute('data-message-slice') ?? row.getAttribute('data-reasoning-block-id') ?? ''
);

export const firstHitRange = (ranges: readonly Range[], reasoning: boolean): Range | undefined => (
  reasoning ? ranges[0] : ranges.find((range) => !range.startContainer.parentElement?.closest('[data-reasoning-message-id]'))
);

const visibleBand = (node: HTMLElement): Span => {
  const composer = node.closest('[data-composer-bound]')?.querySelector('[data-composer-slot="floating"]')?.getBoundingClientRect();
  const bottom = composer ? Math.min(node.clientHeight, composer.top - node.getBoundingClientRect().top) : node.clientHeight;
  return { top: messageLinkOffsetTop(node), bottom: bottom - COMPOSER_GAP_PX };
};

type Located =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'below'; readonly row: HTMLElement }
  | { readonly kind: 'match'; readonly range: Range; readonly row: HTMLElement };

const locate = (node: HTMLElement, messageId: string, reasoning: boolean, terms: readonly string[], walked: Element | null): Located => {
  const selector = reasoning
    ? `[data-reasoning-message-id="${CSS.escape(messageId)}"]`
    : `[data-message-id="${CSS.escape(messageId)}"]:not([data-message-hoisted])`;
  const rows = [...node.querySelectorAll<HTMLElement>(selector)]
    .map((row) => ({ row, rect: row.getBoundingClientRect() }))
    .sort((a, b) => a.rect.top - b.rect.top);
  const resume = rows.findIndex(({ row }) => row === walked);
  if (resume < 0 && (rows.length === 0 || rows[0].row.hasAttribute('data-message-slice'))) return { kind: 'hidden' };
  for (let index = Math.max(0, resume); index < rows.length; index += 1) {
    const { row, rect } = rows[index];
    if (reasoning && row.querySelector(':scope > [aria-expanded="false"]')) return { kind: 'hidden' };
    if (row.querySelector('[data-chat-quote-pending]')) return { kind: 'pending' };
    const range = firstHitRange(findTermRanges(row, terms), reasoning);
    if (range) return { kind: 'match', range, row };
    const next = rows[index + 1];
    if (row.hasAttribute('data-message-continues') && (!next || next.rect.top - rect.bottom > ADJACENT_ROW_PX)) return { kind: 'below', row };
  }
  return { kind: 'absent' };
};

export const revealSearchHit = ({ node, sessionId, messageId, reasoning, terms, onMatch }: {
  node: HTMLElement;
  sessionId: string;
  messageId: string;
  reasoning: boolean;
  terms: readonly string[];
  onMatch: (row: string) => void;
}): (() => void) => {
  let finished = false;
  let cancelFrame: (() => void) | null = null;
  let focused = false;
  let released = false;
  let gliding = false;
  let aimedAt = Number.NaN;
  let walked: Element | null = null;
  let scrolledBox: Element | null = null;
  const page = node.ownerDocument;
  const schedule = () => {
    if (!finished && cancelFrame === null) cancelFrame = onNextFrame(walk);
  };
  const glide = createFollowGlide({
    node,
    shouldContinue: () => !finished,
    onSettle: () => {
      gliding = false;
      schedule();
    },
    onYield: () => {
      gliding = false;
      schedule();
    },
    native: drawsScrollInWholePixels(),
  });
  const release = () => {
    released = true;
    dispatchNavigationRelease(node);
  };
  const focusMessage = () => {
    if (focused) return;
    focused = true;
    released = false;
    requestMessageFocus(sessionId, messageId);
  };
  const aim = (target: number) => {
    if (gliding && Math.abs(target - aimedAt) <= 1) return;
    if (!released) release();
    const instant = prefersReducedMotion();
    gliding = !instant;
    aimedAt = target;
    glide.aim(target, 0, instant);
  };
  const maxScroll = () => Math.max(0, node.scrollHeight - node.clientHeight);
  const contentSpan = (rect: DOMRect): Span => {
    const offset = node.scrollTop - node.getBoundingClientRect().top;
    return { top: rect.top + offset, bottom: rect.bottom + offset };
  };
  const matchRect = (range: Range, row: Element): DOMRect => {
    const match = range.getBoundingClientRect();
    for (let box = range.startContainer.parentElement; box && box !== row; box = box.parentElement) {
      const { overflowY } = getComputedStyle(box);
      if (overflowY === 'visible') continue;
      const rect = box.getBoundingClientRect();
      if (match.top >= rect.top && match.bottom <= rect.bottom) continue;
      if ((overflowY === 'auto' || overflowY === 'scroll') && box !== scrolledBox) {
        scrolledBox = box;
        box.scrollTo({ top: box.scrollTop + (match.top + match.bottom - rect.top - rect.bottom) / 2, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
      return rect;
    }
    return match;
  };
  function walk() {
    cancelFrame = null;
    if (finished) return;
    if (gliding && !glide.isHeadingTo(0, node.scrollTop)) gliding = false;
    const located = locate(node, messageId, reasoning, terms, walked);
    if (located.kind === 'pending') return;
    if (located.kind === 'hidden' || located.kind === 'absent') {
      focusMessage();
      if (located.kind === 'absent') stop();
      return;
    }
    const band = visibleBand(node);
    if (located.kind === 'below') {
      walked = located.row;
      const bottom = contentSpan(located.row.getBoundingClientRect()).bottom;
      const target = Math.min(maxScroll(), bottom - band.bottom);
      if (bottom < node.scrollTop) focusMessage();
      else if (target > node.scrollTop + 1) aim(target);
      return;
    }
    onMatch(searchRowIdentity(located.row));
    const target = resolveMatchScrollTarget(contentSpan(matchRect(located.range, located.row)), node.scrollTop, band, maxScroll());
    if (target !== null) aim(target);
    else if (!gliding) stop();
  }
  const observer = new MutationObserver(schedule);
  function stop() {
    if (finished) return;
    finished = true;
    cancelFrame?.();
    observer.disconnect();
    glide.dispose();
    for (const event of SCROLLER_INPUT_EVENTS) node.removeEventListener(event, stop);
    for (const event of PAGE_INPUT_EVENTS) page.removeEventListener(event, stop, { capture: true });
  }
  observer.observe(node, { childList: true, subtree: true, characterData: true });
  for (const event of SCROLLER_INPUT_EVENTS) node.addEventListener(event, stop, { passive: true });
  for (const event of PAGE_INPUT_EVENTS) page.addEventListener(event, stop, { capture: true, passive: true });
  release();
  walk();
  return stop;
};
