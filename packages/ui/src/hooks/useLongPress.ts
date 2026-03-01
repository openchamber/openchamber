import { useRef, useCallback, useEffect } from 'react';
import { runHapticFeedback } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';

type LongPressOptions = {
  delay?: number;
  onLongPress: () => void;
  onTap?: () => void;
  enableHaptic?: boolean;
};

export function useLongPress({
  delay = 500,
  onLongPress,
  onTap,
  enableHaptic = true,
}: LongPressOptions) {
  const mobileHapticsEnabled = useUIStore((state) => state.mobileHapticsEnabled);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent | React.TouchEvent) => {
    isLongPressRef.current = false;
    
    // Store start position to detect movement
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.PointerEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.PointerEvent).clientY;
    startPosRef.current = { x: clientX, y: clientY };

    timerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      void runHapticFeedback('selection', enableHaptic && mobileHapticsEnabled);
      onLongPress();
    }, delay);
  }, [delay, onLongPress, enableHaptic, mobileHapticsEnabled]);

  const onPointerMove = useCallback((e: React.PointerEvent | React.TouchEvent) => {
    if (!startPosRef.current || !timerRef.current) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.PointerEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.PointerEvent).clientY;

    // If moved more than 10px, cancel long press
    const dx = Math.abs(clientX - startPosRef.current.x);
    const dy = Math.abs(clientY - startPosRef.current.y);
    
    if (dx > 10 || dy > 10) {
      clear();
    }
  }, [clear]);

  const onPointerUp = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!isLongPressRef.current && onTap) {
        // Only trigger tap if we didn't drag too far (checked in move)
        // and didn't trigger long press
        onTap();
      }
    }
    clear();
  }, [clear, onTap]);

  const onPointerLeave = useCallback(() => {
    clear();
  }, [clear]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Prevent default context menu on long press
    if (isLongPressRef.current) {
      e.preventDefault();
    }
  }, []);

  useEffect(() => clear, [clear]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onTouchStart: onPointerDown, // Add touch handlers for better mobile support
    onTouchMove: onPointerMove,
    onTouchEnd: onPointerUp,
    onContextMenu,
  };
}
