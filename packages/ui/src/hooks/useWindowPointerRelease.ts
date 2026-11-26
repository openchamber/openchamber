import React from 'react';

export const useWindowPointerRelease = (active: boolean, onRelease: (pointerId: number | null) => void): void => {
  React.useEffect(() => {
    if (!active) {
      return;
    }
    const handleUp = (event: PointerEvent) => onRelease(event.pointerId);
    const handleBlur = () => onRelease(null);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [active, onRelease]);
};
