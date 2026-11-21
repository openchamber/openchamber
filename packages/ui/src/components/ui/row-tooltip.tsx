import React from 'react';

import { Tooltip, TooltipContent } from '@/components/ui/tooltip';

const OPEN_DELAY_MS = 300;

const anchorOf = (target: EventTarget | null): HTMLElement | null => (
  target instanceof Element ? target.closest<HTMLElement>('[data-row-tooltip]') : null
);

export function DelegatedTooltip({ containerRef, sideOffset = 6, className }: {
  containerRef: React.RefObject<HTMLElement | null>;
  sideOffset?: number;
  className?: string;
}) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let current: HTMLElement | null = null;
    let open = false;
    let timer: number | undefined;

    const close = () => {
      window.clearTimeout(timer);
      open = false;
      setAnchor(null);
    };
    const show = (target: HTMLElement) => {
      open = true;
      setAnchor(target);
    };
    const moveTo = (target: HTMLElement | null) => {
      if (target === current) return;
      current = target;
      window.clearTimeout(timer);
      if (!target) {
        close();
      } else if (open) {
        show(target);
      } else {
        timer = window.setTimeout(() => show(target), OPEN_DELAY_MS);
      }
    };

    const handlePointerOver = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
      moveTo(anchorOf(event.target));
    };
    const handleLeave = () => moveTo(null);
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(':focus-visible')) moveTo(anchorOf(event.target));
    };

    container.addEventListener('pointerover', handlePointerOver);
    container.addEventListener('pointerleave', handleLeave);
    container.addEventListener('pointerdown', close);
    container.addEventListener('keydown', close);
    container.addEventListener('focusin', handleFocusIn);
    container.addEventListener('focusout', handleLeave);
    container.addEventListener('click', close, true);
    container.addEventListener('scroll', close, true);
    return () => {
      window.clearTimeout(timer);
      container.removeEventListener('pointerover', handlePointerOver);
      container.removeEventListener('pointerleave', handleLeave);
      container.removeEventListener('pointerdown', close);
      container.removeEventListener('keydown', close);
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('focusout', handleLeave);
      container.removeEventListener('click', close, true);
      container.removeEventListener('scroll', close, true);
    };
  }, [containerRef]);

  if (!anchor?.isConnected) return null;
  return (
    <Tooltip open onOpenChange={() => setAnchor(null)}>
      <TooltipContent anchor={anchor} side="top" sideOffset={sideOffset} className={className}>
        {anchor.dataset.rowTooltip}
      </TooltipContent>
    </Tooltip>
  );
}

type HoverTargetProps = {
  onPointerEnter?: React.PointerEventHandler<HTMLElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
};

export function HoverTooltip({ label, side = 'top', children }: {
  label: React.ReactNode;
  side?: 'top' | 'bottom';
  children: React.ReactElement<HoverTargetProps>;
}) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const timerRef = React.useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const close = () => {
    clearTimer();
    setAnchor(null);
  };
  React.useEffect(() => clearTimer, []);

  const child = children.props;
  const trigger = React.cloneElement(children, {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      child.onPointerEnter?.(event);
      if (event.pointerType !== 'mouse') return;
      const target = event.currentTarget;
      clearTimer();
      timerRef.current = window.setTimeout(() => setAnchor(target), OPEN_DELAY_MS);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      child.onPointerLeave?.(event);
      close();
    },
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      child.onPointerDown?.(event);
      close();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      child.onFocus?.(event);
      if (event.target.matches(':focus-visible')) setAnchor(event.currentTarget);
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      child.onBlur?.(event);
      close();
    },
  });

  return (
    <>
      {trigger}
      {anchor?.isConnected ? (
        <Tooltip open onOpenChange={close}>
          <TooltipContent anchor={anchor} side={side} sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}
