import React from 'react';

type Args = {
  enabled?: boolean;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchContainerRef: React.RefObject<HTMLDivElement | null>;
};

export const useSessionSearchEffects = ({
  enabled = true,
  isSessionSearchOpen,
  setIsSessionSearchOpen,
  sessionSearchInputRef,
  sessionSearchContainerRef,
}: Args): void => {
  React.useEffect(() => {
    if (!enabled || !isSessionSearchOpen || typeof window === 'undefined') {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      sessionSearchInputRef.current?.focus();
      sessionSearchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [enabled, isSessionSearchOpen, sessionSearchInputRef]);

  React.useEffect(() => {
    if (!enabled || !isSessionSearchOpen || typeof document === 'undefined') {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!sessionSearchContainerRef.current) {
        return;
      }
      if (!sessionSearchContainerRef.current.contains(event.target as Node)) {
        setIsSessionSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [enabled, isSessionSearchOpen, setIsSessionSearchOpen, sessionSearchContainerRef]);
};
