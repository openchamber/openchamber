import type { GuestPopoverRequest, GuestPopoverSide } from '@openchamber/sdk';

type GuestPopoverFrameBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
};

export type GuestPopoverPosition = {
  left: number;
  top: number;
  width: number;
  height: number;
  side: GuestPopoverSide;
};

type PopoverPositionRequest = Pick<GuestPopoverRequest, 'anchor' | 'width' | 'height' | 'side'> & {
  frame: GuestPopoverFrameBounds;
  viewport: { width: number; height: number };
};

const GUTTER = 8;
const GAP = 6;
export const GUEST_POPOVER_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/** A guest preview must never cover a host permission or modal dialog. */
export const guestPopoverOwnerBlocked = (frame: HTMLIFrameElement): boolean => (
  !frame.isConnected || frame.closest('[inert],[aria-hidden="true"],[data-base-ui-inert]') !== null
  || frame.ownerDocument.documentElement.classList.contains('oc-dialog-open')
  || Array.from(frame.ownerDocument.querySelectorAll(GUEST_POPOVER_MODAL_SELECTOR)).some((element) => element.getClientRects().length > 0)
);

export type GuestPopoverActivation = {
  id: string;
  authorize: () => boolean;
  close: (reason: 'escape' | 'outside' | 'anchor' | 'owner' | 'closed' | 'replaced') => void;
};

/** One document-owned lease. A stale owner may never release a replacement. */
export class GuestPopoverController {
  #active: GuestPopoverActivation | null = null;

  claim(activation: GuestPopoverActivation): GuestPopoverActivation {
    if (this.#active) this.retire(this.#active, 'replaced');
    this.#active = activation;
    return activation;
  }

  current(): GuestPopoverActivation | null {
    return this.#active;
  }

  release(activation: GuestPopoverActivation): void {
    if (this.#active === activation) this.#active = null;
  }

  authorize(activation: GuestPopoverActivation): boolean {
    if (this.#active !== activation || activation.authorize()) return this.#active === activation;
    this.retire(activation, 'owner');
    return false;
  }

  retire(activation: GuestPopoverActivation, reason: Parameters<GuestPopoverActivation['close']>[0]): void {
    if (this.#active !== activation) return;
    this.#active = null;
    activation.close(reason);
  }
}

const controllersByDocument = new WeakMap<Document, GuestPopoverController>();

export const getGuestPopoverController = (ownerDocument: Document): GuestPopoverController => {
  const existing = controllersByDocument.get(ownerDocument);
  if (existing) return existing;
  const controller = new GuestPopoverController();
  controllersByDocument.set(ownerDocument, controller);
  return controller;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Converts an owner-frame CSS-pixel anchor into a host viewport position. */
export const positionGuestPopover = (request: PopoverPositionRequest): GuestPopoverPosition | null => {
  const { anchor, frame, viewport } = request;
  if (frame.clientWidth <= 0 || frame.clientHeight <= 0 || viewport.width <= GUTTER * 2 || viewport.height <= GUTTER * 2) return null;

  const scaleX = frame.width / frame.clientWidth;
  const scaleY = frame.height / frame.clientHeight;
  const anchorLeft = frame.left + anchor.x * scaleX;
  const anchorTop = frame.top + anchor.y * scaleY;
  const anchorRight = anchorLeft + anchor.width * scaleX;
  const anchorBottom = anchorTop + anchor.height * scaleY;
  const visibleLeft = Math.max(anchorLeft, frame.left, 0);
  const visibleTop = Math.max(anchorTop, frame.top, 0);
  const visibleRight = Math.min(anchorRight, frame.left + frame.width, viewport.width);
  const visibleBottom = Math.min(anchorBottom, frame.top + frame.height, viewport.height);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

  const width = Math.min(request.width, viewport.width - GUTTER * 2);
  const height = Math.min(request.height, viewport.height - GUTTER * 2);
  let side = request.side ?? 'left';
  const centerX = (visibleLeft + visibleRight) / 2;
  const centerY = (visibleTop + visibleBottom) / 2;
  const enough = (candidate: GuestPopoverSide): boolean => {
    if (candidate === 'left') return visibleLeft - GAP - width >= GUTTER;
    if (candidate === 'right') return visibleRight + GAP + width <= viewport.width - GUTTER;
    if (candidate === 'top') return visibleTop - GAP - height >= GUTTER;
    return visibleBottom + GAP + height <= viewport.height - GUTTER;
  };
  if (!enough(side)) {
    const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } satisfies Record<GuestPopoverSide, GuestPopoverSide>;
    if (enough(opposite[side])) side = opposite[side];
  }

  let left = centerX - width / 2;
  let top = centerY - height / 2;
  if (side === 'left') left = visibleLeft - GAP - width;
  if (side === 'right') left = visibleRight + GAP;
  if (side === 'top') top = visibleTop - GAP - height;
  if (side === 'bottom') top = visibleBottom + GAP;
  return {
    left: clamp(left, GUTTER, viewport.width - GUTTER - width),
    top: clamp(top, GUTTER, viewport.height - GUTTER - height),
    width,
    height,
    side,
  };
};
