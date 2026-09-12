import React from 'react';

export type LongPressOptions = {
  delayMs?: number;
  moveTolerancePx?: number;
};

export type LongPressHandlers = {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
};

export interface LongPressController {
  handlers: LongPressHandlers;
  reset: () => void;
}

export const LONG_PRESS_DEFAULT_DELAY_MS = 500;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export const createLongPressController = (
  onLongPress: (() => void) | undefined,
  options: LongPressOptions = {},
): LongPressController => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;
  let suppressClick = false;

  const { delayMs = LONG_PRESS_DEFAULT_DELAY_MS, moveTolerancePx = LONG_PRESS_MOVE_TOLERANCE_PX } = options;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    origin = null;
    suppressClick = false;
  };

  const fire = () => {
    clear();
    suppressClick = true;
    onLongPress?.();
  };

  const handlers: LongPressHandlers = {
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      clear();
      suppressClick = false;
      origin = { x: event.clientX, y: event.clientY };
      timer = setTimeout(fire, delayMs);
    },
    onPointerMove: (event) => {
      if (timer === null || !origin) return;
      if (Math.abs(event.clientX - origin.x) > moveTolerancePx || Math.abs(event.clientY - origin.y) > moveTolerancePx) {
        clear();
      }
    },
    onPointerUp: () => {
      clear();
    },
    onPointerCancel: () => {
      clear();
    },
    onClickCapture: (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event) => {
      event.preventDefault();
      fire();
    },
  };

  return { handlers, reset: () => { clear(); suppressClick = false; } };
};

export const useLongPress = (onLongPress?: () => void, options?: LongPressOptions): LongPressHandlers => {
  const callbackRef = React.useRef(onLongPress);
  callbackRef.current = onLongPress;

  const controllerRef = React.useRef<LongPressController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createLongPressController(() => callbackRef.current?.(), options);
  }

  React.useEffect(() => {
    return () => {
      controllerRef.current?.reset();
    };
  }, []);

  return controllerRef.current.handlers;
};