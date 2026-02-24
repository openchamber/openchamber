import React from 'react';
import { animate } from 'motion/react';
import { useDrawer } from '@/contexts/DrawerContext';

type DrawerSwipeOptions = {
  edgeSide?: 'left' | 'right';
  strictHorizontalIntent?: boolean;
  horizontalIntentRatio?: number;
  activationDistance?: number;
  onlyWhenClosed?: boolean;
};

export function useDrawerSwipe(options: DrawerSwipeOptions = {}) {
  const drawer = useDrawer();
  const {
    edgeSide,
    strictHorizontalIntent = false,
    horizontalIntentRatio = 1.35,
    activationDistance = 30,
    onlyWhenClosed = false,
  } = options;
  const touchStartXRef = React.useRef(0);
  const touchStartYRef = React.useRef(0);
  const isHorizontalSwipeRef = React.useRef<boolean | null>(null);
  const isDraggingDrawerRef = React.useRef<'left' | 'right' | null>(null);

  const handleTouchStart = React.useCallback((e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
    isHorizontalSwipeRef.current = null;
    isDraggingDrawerRef.current = null;
  }, []);

  const handleTouchMove = React.useCallback((e: React.TouchEvent) => {
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - touchStartXRef.current;
    const deltaY = currentY - touchStartYRef.current;

    if (isHorizontalSwipeRef.current === null) {
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        if (strictHorizontalIntent) {
          isHorizontalSwipeRef.current = Math.abs(deltaX) > Math.abs(deltaY) * horizontalIntentRatio;
        } else {
          isHorizontalSwipeRef.current = Math.abs(deltaX) > Math.abs(deltaY);
        }
      }
    }

    if (isHorizontalSwipeRef.current === true) {
      if (onlyWhenClosed && (drawer.leftDrawerOpen || drawer.rightDrawerOpen)) {
        return;
      }

      const leftDrawerWidthPx = drawer.leftDrawerWidth.current || window.innerWidth * 0.85;
      const rightDrawerWidthPx = drawer.rightDrawerWidth.current || window.innerWidth * 0.85;

      if (isDraggingDrawerRef.current === null) {
        if (!edgeSide && drawer.leftDrawerOpen && deltaX > 10) {
          isDraggingDrawerRef.current = 'left';
        } else if (!edgeSide && drawer.rightDrawerOpen && deltaX < -10) {
          isDraggingDrawerRef.current = 'right';
        } else if (!drawer.leftDrawerOpen && !drawer.rightDrawerOpen) {
          if (edgeSide === 'left') {
            if (deltaX > activationDistance) {
              isDraggingDrawerRef.current = 'left';
            }
          } else if (edgeSide === 'right') {
            if (deltaX < -activationDistance) {
              isDraggingDrawerRef.current = 'right';
            }
          } else if (deltaX > activationDistance) {
            isDraggingDrawerRef.current = 'left';
          } else if (deltaX < -activationDistance) {
            isDraggingDrawerRef.current = 'right';
          }
        }
      }

      if (!isDraggingDrawerRef.current) {
        return;
      }

      e.preventDefault();

      if (isDraggingDrawerRef.current === 'left') {
        if (drawer.leftDrawerOpen) {
          const progress = Math.max(0, Math.min(1, deltaX / leftDrawerWidthPx));
          drawer.leftDrawerX.set(-leftDrawerWidthPx * (1 - progress));
        } else {
          const progress = Math.max(0, Math.min(1, deltaX / leftDrawerWidthPx));
          drawer.leftDrawerX.set(-leftDrawerWidthPx + (leftDrawerWidthPx * progress));
        }
      }

      if (isDraggingDrawerRef.current === 'right') {
        if (drawer.rightDrawerOpen) {
          const progress = Math.max(0, Math.min(1, -deltaX / rightDrawerWidthPx));
          drawer.rightDrawerX.set(rightDrawerWidthPx * (1 - progress));
        } else {
          const progress = Math.max(0, Math.min(1, -deltaX / rightDrawerWidthPx));
          drawer.rightDrawerX.set(rightDrawerWidthPx - (rightDrawerWidthPx * progress));
        }
      }
    }
  }, [activationDistance, drawer, edgeSide, horizontalIntentRatio, onlyWhenClosed, strictHorizontalIntent]);

  const handleTouchEnd = React.useCallback((e: React.TouchEvent) => {
    if (isHorizontalSwipeRef.current !== true) return;

    const endX = e.changedTouches[0].clientX;
    const deltaX = endX - touchStartXRef.current;
    const velocityThreshold = 500;
    const progressThreshold = 0.3;

    const leftDrawerWidthPx = drawer.leftDrawerWidth.current || window.innerWidth * 0.85;
    const rightDrawerWidthPx = drawer.rightDrawerWidth.current || window.innerWidth * 0.85;

    if (isDraggingDrawerRef.current === 'left') {
      const isOpen = drawer.leftDrawerOpen;
      const currentX = drawer.leftDrawerX.get();
      const progress = isOpen
        ? 1 - Math.abs(currentX) / leftDrawerWidthPx
        : 1 + currentX / leftDrawerWidthPx;

      const shouldComplete = progress > progressThreshold || Math.abs(deltaX * 10) > velocityThreshold;

      if (shouldComplete) {
        const targetX = isOpen ? -leftDrawerWidthPx : 0;
        animate(drawer.leftDrawerX, targetX, {
          type: 'spring',
          stiffness: 400,
          damping: 35,
          mass: 0.8,
        });
        drawer.setMobileLeftDrawerOpen(!isOpen);
      } else {
        const targetX = isOpen ? 0 : -leftDrawerWidthPx;
        animate(drawer.leftDrawerX, targetX, {
          type: 'spring',
          stiffness: 400,
          damping: 35,
          mass: 0.8,
        });
      }

      isDraggingDrawerRef.current = null;
      return;
    }

    if (isDraggingDrawerRef.current === 'right') {
      const isOpen = drawer.rightDrawerOpen;
      const currentX = drawer.rightDrawerX.get();
      const progress = isOpen
        ? 1 - Math.abs(currentX) / rightDrawerWidthPx
        : 1 - currentX / rightDrawerWidthPx;

      const shouldComplete = progress > progressThreshold || Math.abs(deltaX * 10) > velocityThreshold;

      if (shouldComplete) {
        const targetX = isOpen ? rightDrawerWidthPx : 0;
        animate(drawer.rightDrawerX, targetX, {
          type: 'spring',
          stiffness: 400,
          damping: 35,
          mass: 0.8,
        });
        drawer.setRightSidebarOpen(!isOpen);
      } else {
        const targetX = isOpen ? 0 : rightDrawerWidthPx;
        animate(drawer.rightDrawerX, targetX, {
          type: 'spring',
          stiffness: 400,
          damping: 35,
          mass: 0.8,
        });
      }

      isDraggingDrawerRef.current = null;
      return;
    }

    isHorizontalSwipeRef.current = null;
  }, [drawer]);

  return {
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
