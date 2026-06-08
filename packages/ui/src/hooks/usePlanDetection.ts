import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

type SessionMessageRecord = { info: Message; parts: Part[] };

/**
 * Watches session messages for plan creation and marks sessions as plan-available.
 * 
 * This is the single source of truth for plan detection. When a plan_enter tool
 * executes, it creates a synthetic message like "The plan at ${path}" or 
 * "User has requested to enter plan mode". We detect these and signal availability.
 * 
 * The Header component subscribes to sessionPlanAvailable map to show/hide the Plan tab.
 */
export const usePlanDetection = (sessionId: string, messageRecords: SessionMessageRecord[]) => {
  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const markSessionPlanAvailable = useSessionUIStore((state) => state.markSessionPlanAvailable);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);

  React.useEffect(() => {
    // Early exit if plan mode is disabled - don't parse messages
    if (!planModeEnabled) return;
    if (!sessionId) return;

    // Already marked as available - no need to check again
    if (isSessionPlanAvailable(sessionId)) return;

    // Scan the already-materialized message records used by ChatContainer so
    // plan detection does not add a second active-session message subscription.
    for (const message of messageRecords) {
      // Only check assistant messages for plan references
      if (message.info.role !== 'assistant') continue;

      for (const part of message.parts) {
        const record = part as { type?: string; text?: string };
        if (record.type !== 'text') continue;
        const text = record.text || '';

        // Check for plan file reference in synthetic messages
        if (text.includes('The plan at ') || text.includes('User has requested to enter plan mode')) {
          markSessionPlanAvailable(sessionId);
          return;
        }
      }
    }
  }, [planModeEnabled, sessionId, messageRecords, markSessionPlanAvailable, isSessionPlanAvailable]);
};
