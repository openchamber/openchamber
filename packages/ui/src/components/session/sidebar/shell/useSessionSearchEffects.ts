import React from 'react';

type Args = {
  enabled?: boolean;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
};

/**
 * The open_session_list shortcut lands here when the sidebar is visible: the
 * session list is already on screen, so the shortcut puts the caret in its
 * search field.
 */
export const useSessionSearchEffects = ({ enabled = true, sessionSearchInputRef }: Args): void => {
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }
    const handleOpenRequest = () => {
      sessionSearchInputRef.current?.focus();
      sessionSearchInputRef.current?.select();
    };
    window.addEventListener('openchamber:sidebar-session-search', handleOpenRequest);
    return () => window.removeEventListener('openchamber:sidebar-session-search', handleOpenRequest);
  }, [enabled, sessionSearchInputRef]);
};
