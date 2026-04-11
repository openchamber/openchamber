import { useEffect, useRef } from 'react';
import { useUIStore } from '@/stores/useUIStore';

interface EdgeSwipeOptions {
  edgeThreshold?: number;
  minSwipeDistance?: number;
  maxSwipeTime?: number;
  enabled?: boolean;
}

export const useEdgeSwipe = (options: EdgeSwipeOptions = {}) => {
  const {
    edgeThreshold = 30,
    minSwipeDistance = 50,
    maxSwipeTime = 300,
    enabled = true,
  } = options;

  const isMobile = useUIStore((state) => state.isMobile);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const touchEndRef = useRef<{ x: number; y: number; time: number } | null>(null);

  useEffect(() => {
    if (!enabled || !isMobile) return;

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) {
        touchStartRef.current = null;
        return;
      }

      const fromLeft = touch.clientX <= edgeThreshold;

      if (fromLeft) {
        touchStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        };
      } else {
        touchStartRef.current = null;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStartRef.current) {
        return;
      }

      const touch = e.touches[0];
      if (!touch) {
        return;
      }

      const deltaX = touch.clientX - touchStartRef.current.x;

      if (deltaX > 10) {
        e.preventDefault();
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;

      const touch = e.changedTouches[0];
      if (!touch) {
        touchStartRef.current = null;
        touchEndRef.current = null;
        return;
      }

      touchEndRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };

      const { x: startX, y: startY, time: startTime } = touchStartRef.current;
      const { x: endX, y: endY, time: endTime } = touchEndRef.current;

      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const deltaTime = endTime - startTime;

      const isHorizontal = Math.abs(deltaY) < Math.abs(deltaX);
      const isQuick = deltaTime <= maxSwipeTime;
      const limitedVertical = Math.abs(deltaY) < minSwipeDistance;

      const isValidLeftSwipe =
        deltaX >= minSwipeDistance && isHorizontal && isQuick && limitedVertical;

      if (isValidLeftSwipe && !isSessionSwitcherOpen) {
        setSessionSwitcherOpen(true);
      }

      touchStartRef.current = null;
      touchEndRef.current = null;
    };

    const handleTouchCancel = () => {
      touchStartRef.current = null;
      touchEndRef.current = null;
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', handleTouchCancel, { passive: true, capture: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart, { capture: true });
      document.removeEventListener('touchmove', handleTouchMove, { capture: true });
      document.removeEventListener('touchend', handleTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', handleTouchCancel, { capture: true });
    };
  }, [
    enabled,
    isMobile,
    edgeThreshold,
    minSwipeDistance,
    maxSwipeTime,
    setSessionSwitcherOpen,
    isSessionSwitcherOpen,
  ]);

  return null;
};
