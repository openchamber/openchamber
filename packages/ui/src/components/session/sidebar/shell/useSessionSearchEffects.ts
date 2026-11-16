import React from 'react';

type Args = {
  enabled?: boolean;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
};

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
