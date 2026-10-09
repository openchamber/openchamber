import React from 'react';

type Args = {
  enabled?: boolean;
  isSessionSearchOpen: boolean;
  openSessionSearch: () => void;
  /** Hides the field and drops its query: a filter nobody can see is a trap. */
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchContainerRef: React.RefObject<HTMLDivElement | null>;
};

export const useSessionSearchEffects = ({
  enabled = true,
  isSessionSearchOpen,
  openSessionSearch,
  closeSessionSearch,
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

  // The open_session_list shortcut lands here when the sidebar is visible:
  // the session list is already on screen, so the shortcut opens its search.
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }
    const handleOpenRequest = () => {
      openSessionSearch();
      sessionSearchInputRef.current?.focus();
      sessionSearchInputRef.current?.select();
    };
    window.addEventListener('openchamber:sidebar-session-search', handleOpenRequest);
    return () => window.removeEventListener('openchamber:sidebar-session-search', handleOpenRequest);
  }, [enabled, openSessionSearch, sessionSearchInputRef]);

  React.useEffect(() => {
    if (!enabled || !isSessionSearchOpen || typeof document === 'undefined') {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!sessionSearchContainerRef.current) {
        return;
      }
      if (!sessionSearchContainerRef.current.contains(event.target as Node)) {
        closeSessionSearch();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [enabled, isSessionSearchOpen, closeSessionSearch, sessionSearchContainerRef]);
};
