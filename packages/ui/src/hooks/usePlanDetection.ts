import React from 'react';
import { useSessionMessages } from '@/sync/sync-context';
import { getSyncParts } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

/**
 * Watches session messages for plan creation and marks sessions as plan-available.
 * 
 * This is the single source of truth for plan detection. When a plan_enter tool
 * executes, it creates a synthetic message like "The plan at ${path}" or 
 * "User has requested to enter plan mode". We detect these and signal availability.
 * 
 * The Header component subscribes to sessionPlanAvailable map to show/hide the Plan tab.
 */
export const usePlanDetection = (sessionId: string, directory?: string) => {
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const markSessionPlanAvailable = useSessionUIStore((state) => state.markSessionPlanAvailable);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);
  const messages = useSessionMessages(sessionId, directory);

  React.useEffect(() => {
    // Early exit if plan mode is disabled - don't parse messages
    if (!planModeEnabled) return;
    if (!sessionId) return;

    // Already marked as available - no need to check again
    if (isSessionPlanAvailable(sessionId)) return;

    // Scan messages for plan references
    for (const message of messages) {
      // Only check assistant messages for plan references
      if (message.role !== 'assistant') continue;

      const parts = getSyncParts(message.id, directory);
      for (const part of parts) {
        if (part.type !== 'text') continue;
        const text = (part as { text?: string }).text || '';

        // Check for plan file reference in synthetic messages
        if (text.includes('The plan at ') || text.includes('User has requested to enter plan mode')) {
          markSessionPlanAvailable(sessionId);
          return;
        }
      }
    }
  }, [planModeEnabled, sessionId, directory, messages, markSessionPlanAvailable, isSessionPlanAvailable]);
};
