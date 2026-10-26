import React from 'react';
import { createPortal } from 'react-dom';

import { GUEST_POPOVER_MODAL_SELECTOR, guestPopoverOwnerBlocked, type GuestPopoverPosition } from '@/lib/guests/popovers';

type GuestPopoverProps = {
  position: GuestPopoverPosition;
  focused: boolean;
  label: string;
  ownerFrame: HTMLIFrameElement | null;
  onClose: (reason: 'escape' | 'outside') => void;
  onEnter: () => void;
  onLeave: () => void;
  onOutsideHover: () => void;
  children: React.ReactNode;
};

/** Host-owned portal for one sandboxed extension popover frame. */
export const GuestPopover: React.FC<GuestPopoverProps> = ({ position, focused, label, ownerFrame, onClose, onEnter, onLeave, onOutsideHover, children }) => {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const pointerInsideRef = React.useRef(false);
  const reportActivity = React.useCallback(() => {
    if (pointerInsideRef.current || overlayRef.current?.contains(document.activeElement)) onEnter();
    else onLeave();
  }, [onEnter, onLeave]);
  React.useEffect(() => {
    if (focused) overlayRef.current?.querySelector('iframe')?.focus();
  }, [focused]);
  React.useEffect(() => {
    if (!ownerFrame || guestPopoverOwnerBlocked(ownerFrame)) { onClose('outside'); return; }
    // Keys pressed inside the owner or preview frame stay in those documents.
    // Any key reaching the host means the user works elsewhere, such as typing
    // in the composer the preview may cover.
    const onKeyDown = (event: KeyboardEvent) => {
      const insideGuest = document.activeElement === ownerFrame || overlayRef.current?.contains(document.activeElement);
      if (event.key === 'Escape' && insideGuest) {
        event.preventDefault();
        event.stopPropagation();
        onClose('escape');
      } else if (event.key === 'Escape' || !insideGuest) onClose('outside');
    };
    const onPointerDown = (event: PointerEvent) => {
      const overlay = overlayRef.current;
      if (!overlay || !event.composedPath().includes(overlay)) onClose('outside');
    };
    const onResize = () => onClose('outside');
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === document || (target instanceof window.Node && ownerFrame && target.contains(ownerFrame))) onClose('outside');
    };
    const onWindowBlur = () => {
      queueMicrotask(() => {
        const active = document.activeElement;
        const overlayFrame = overlayRef.current?.querySelector('iframe') ?? null;
        if (!document.hasFocus() || (active !== ownerFrame && active !== overlayFrame)) onClose('outside');
        else reportActivity();
      });
    };
    const onFocusIn = (event: FocusEvent) => {
      const overlay = overlayRef.current;
      if (event.target !== ownerFrame && (!overlay || !event.composedPath().includes(overlay))) onClose('outside');
    };
    const onPointerMove = (event: PointerEvent) => {
      const overlay = overlayRef.current;
      if (document.activeElement === ownerFrame || overlay?.contains(document.activeElement)) return;
      if (overlay && event.composedPath().includes(overlay)) return;
      const bounds = ownerFrame?.getBoundingClientRect();
      if (bounds && event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
      onOutsideHover();
    };
    const modalObserver = new window.MutationObserver((records) => {
      const modalChanged = records.some((record) => {
        if (record.type === 'attributes' && record.attributeName !== 'aria-modal') return record.target.contains(ownerFrame);
        const candidates = record.type === 'attributes' ? [record.target] : Array.from(record.addedNodes);
        return candidates.some((node) => node instanceof window.Element
          && (node.matches(GUEST_POPOVER_MODAL_SELECTOR) || node.querySelector(GUEST_POPOVER_MODAL_SELECTOR)));
      });
      if (modalChanged && guestPopoverOwnerBlocked(ownerFrame)) onClose('outside');
    });
    modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-modal', 'aria-hidden', 'inert', 'data-base-ui-inert'] });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize, { once: true });
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointermove', onPointerMove);
      modalObserver.disconnect();
    };
  }, [onClose, onOutsideHover, ownerFrame, reportActivity]);

  return createPortal(
    <div
      id="guest-popover-overlay"
      ref={overlayRef}
      data-guest-popover-overlay
      role="dialog"
      aria-modal={false}
      aria-label={label}
      className="fixed z-[100]"
      style={{ left: position.left, top: position.top, width: position.width, height: position.height }}
      onPointerEnter={() => { pointerInsideRef.current = true; reportActivity(); }}
      onPointerLeave={() => { pointerInsideRef.current = false; reportActivity(); }}
      onFocusCapture={reportActivity}
      onBlurCapture={() => queueMicrotask(reportActivity)}
    >
      <div className="h-full w-full overflow-hidden rounded-[var(--radius)] border border-border bg-[var(--surface-elevated)] shadow-lg">
        {children}
      </div>
    </div>,
    document.body,
  );
};
