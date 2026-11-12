import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { selectSessionTodosOn, useSessionTodosStore } from '@/stores/useSessionTodosStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorkStatusSectionId } from './sections';

/**
 * Built-in sections of features this runtime may not have. A section of a
 * feature the runtime lacks is listed nowhere, the sections dialog included,
 * so the user is never offered a section that stays empty.
 *
 * Tasks shows the agent's list from OpenCode's experimental `todowrite` tool,
 * so it is listed only once the server says the tool is on in the open
 * session's directory.
 *
 * The phone's Status tab also leaves out Usage: the phone has its own Usage
 * page, which reads better there than the panel's compact rows.
 */
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
