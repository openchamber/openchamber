import React from 'react';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { SessionNode } from '../types';

export const useLiveSessionNode = (node: SessionNode): SessionNode => {
  const sessionId = node.session.id;
  const live = useGlobalSessionsStore(React.useCallback((state) => state.entityById.get(sessionId), [sessionId]));
  return React.useMemo(() => (live && live !== node.session ? { ...node, session: live } : node), [live, node]);
};
