import React from 'react';
import { AGENT_CYCLE_LABEL_HOLD_MS } from '@/components/chat/AgentCycleLabel';

/**
 * Briefly reveal the agent label after the active agent changes.
 * Skips the initial mount and empty→named hydration so cold load stays avatar-only.
 * Collapse is driven by the same CSS transition as expand (see AgentCycleLabel).
 */
export function useAgentCycleLabelReveal(agentName: string | null | undefined): boolean {
  const [revealed, setRevealed] = React.useState(false);
  const prevNameRef = React.useRef<string | null | undefined>(undefined);
  const hasMountedRef = React.useRef(false);
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      prevNameRef.current = agentName;
      return;
    }

    if (agentName === prevNameRef.current) {
      return;
    }

    const previousName = prevNameRef.current;
    prevNameRef.current = agentName;

    // Only animate real switches (Tab / picker), not first hydration into a name.
    if (!previousName || !agentName) {
      setRevealed(false);
      return;
    }

    setRevealed(true);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      setRevealed(false);
      hideTimerRef.current = null;
    }, AGENT_CYCLE_LABEL_HOLD_MS);

    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [agentName]);

  React.useEffect(() => () => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
  }, []);

  return revealed;
}
