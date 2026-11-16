import React from 'react';
import type { Session } from '@/lib/opencode/model';

export function useParentSessionBack(
  parentSession: Session | null | undefined,
  hidden: boolean,
  openSession: (id: string, directory: string | null) => void,
  register?: (handler: (() => void) | null) => void,
): () => void {
  const returnToParent = React.useCallback(() => {
    if (parentSession) openSession(parentSession.id, parentSession.directory ?? null);
  }, [openSession, parentSession]);
  React.useLayoutEffect(() => {
    if (!register) return;
    register(parentSession && !hidden ? returnToParent : null);
    return () => register(null);
  }, [register, parentSession, hidden, returnToParent]);
  return returnToParent;
}
