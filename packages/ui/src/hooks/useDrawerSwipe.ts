import React from 'react';
import { animate } from 'motion/react';
import { useDrawer } from '@/contexts/DrawerContext';

export function useDrawerSwipe() {
  const drawer = useDrawer();
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
        isHorizontalSwipeRef.current = Math.abs(deltaX) > Math.abs(deltaY);
      }
    }

    if (isHorizontalSwipeRef.current === true) {
      e.preventDefault();

      const leftDrawerWidthPx = drawer.leftDrawerWidth.current || window.innerWidth * 0.85;
      const rightDrawerWidthPx = drawer.rightDrawerWidth.current || window.innerWidth * 0.85;

      if (isDraggingDrawerRef.current === null) {
        if (drawer.leftDrawerOpen && deltaX > 10) {
          isDraggingDrawerRef.current = 'left';
        } else if (drawer.rightDrawerOpen && deltaX < -10) {
          isDraggingDrawerRef.current = 'right';
        } else if (!drawer.leftDrawerOpen && !drawer.rightDrawerOpen) {
          if (deltaX > 30) {
            isDraggingDrawerRef.current = 'left';
          } else if (deltaX < -30) {
            isDraggingDrawerRef.current = 'right';
          }
        }
      }

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
  }, [drawer]);

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
