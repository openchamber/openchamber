import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { selectSessionTodosOn, useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorkStatusSectionId } from './sections';

export const useUnavailableWorkStatusSections = (): readonly WorkStatusSectionId[] => {
  const workflows = useUIStore(selectWorkflowsShown);
  const isMobile = useUIStore((state) => state.isMobile);
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const tasks = useSessionTodosStore(selectSessionTodosOn(sessionId));
  return React.useMemo(() => [
    ...(isMobile ? ['usage' as const] : []),
    ...(workflows ? [] : ['workflows' as const]),
    ...(tasks ? [] : ['tasks' as const]),
  ], [isMobile, tasks, workflows]);
};
