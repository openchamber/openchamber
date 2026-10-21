import React from 'react';

/**
 * Opens "Continue with another model" for the session a chat column shows.
 * The column owns the dialog, so it stays open while the notice or status row
 * that opened it goes away (a retry that ends, a turn that settles). Null
 * where the column offers no such action: no session, or a subagent's.
 */
export const ContinueWithModelContext = React.createContext<(() => void) | null>(null);

export const useContinueWithModelAction = (): (() => void) | null => React.useContext(ContinueWithModelContext);
