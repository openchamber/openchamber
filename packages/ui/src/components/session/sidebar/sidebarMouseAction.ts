import React from 'react';
import { useDeviceInfo } from '@/lib/device';

function isMouseOnlySidebarAction(target: EventTarget | null, mouseMode: boolean): boolean {
  return mouseMode && target instanceof Element && target.closest('[data-sidebar-mouse-action]') !== null;
}

export function useSidebarMouseActions(mobileVariant: boolean) {
  const { isTablet } = useDeviceInfo();
  const [sidebarMouse, setSidebarMouse] = React.useState(false);
  const blockedTouchAction = React.useRef(false);
  return {
    isTablet,
    alwaysShowActions: mobileVariant || (isTablet && !sidebarMouse),
    sidebarProps: {
      'data-sidebar-mouse': sidebarMouse || undefined,
      onPointerMoveCapture: (event: React.PointerEvent<HTMLDivElement>) => {
        if (!sidebarMouse && !mobileVariant && event.pointerType === 'mouse' && window.innerWidth >= 768) setSidebarMouse(true);
      },
      onPointerDownCapture: (event: React.PointerEvent<HTMLDivElement>) => {
        blockedTouchAction.current = false;
        if (event.pointerType === 'touch') {
          blockedTouchAction.current = isMouseOnlySidebarAction(event.target, sidebarMouse);
          if (blockedTouchAction.current) {
            event.preventDefault();
            event.stopPropagation();
          }
          setSidebarMouse(false);
        }
      },
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (blockedTouchAction.current && event.detail !== 0) {
          blockedTouchAction.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onKeyDownCapture: () => { blockedTouchAction.current = false; },
    },
  };
}
