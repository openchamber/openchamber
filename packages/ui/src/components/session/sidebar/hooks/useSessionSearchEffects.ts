import React from 'react';

type Args = {
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchContainerRef: React.RefObject<HTMLDivElement | null>;
};

export const useSessionSearchEffects = ({
  isSessionSearchOpen,
  setIsSessionSearchOpen,
  sessionSearchInputRef,
  sessionSearchContainerRef,
}: Args): void => {
  React.useEffect(() => {
    if (!isSessionSearchOpen || typeof window === 'undefined') {
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      sessionSearchInputRef.current?.focus();
      sessionSearchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isSessionSearchOpen, sessionSearchInputRef]);

  React.useEffect(() => {
    if (!isSessionSearchOpen || typeof document === 'undefined') {
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
  }, [isSessionSearchOpen, setIsSessionSearchOpen, sessionSearchContainerRef]);
};
