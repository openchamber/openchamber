import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { opencodeClient } from '@/lib/opencode/client';
import { agentTerminalState, refreshSessionTerminals, usePersistentPtysStore, type TrackedPty } from '@/sync/persistent-ptys';

/**
 * How often a session's terminal list is read again while one of its
 * terminals runs. OpenCode announces no exit for these terminals, so without
 * this a terminal that ended kept reading "running" with its Stop until the
 * session was opened again.
 */
const RUNNING_TERMINALS_REFRESH_MS = 5_000;

export const useSessionTerminals = (sessionId: string): TrackedPty[] => usePersistentPtysStore(useShallow((state) => (
  [...state.byId.values()].filter((pty) => pty.sessionID === sessionId)
)));

export const useHasSessionTerminals = (sessionId: string | null): boolean => usePersistentPtysStore((state) => (
  sessionId !== null && [...state.byId.values()].some((pty) => pty.sessionID === sessionId)
));

const useHasRunningSessionTerminal = (sessionId: string | null): boolean => usePersistentPtysStore((state) => (
  sessionId !== null && [...state.byId.values()].some((pty) => pty.sessionID === sessionId && agentTerminalState(pty).kind === 'running')
));

/**
 * Reads the session's terminals when it is shown, and again every few
 * seconds while one of them runs; events keep additions and removals current
 * in between.
 */
export const useSessionTerminalsLoaded = (sessionId: string | null, directory: string | undefined): void => {
  const running = useHasRunningSessionTerminal(sessionId);
  React.useEffect(() => {
    if (!sessionId || !directory) return;
    const read = () => {
      refreshSessionTerminals(sessionId, directory, (id, target) => opencodeClient.listSessionTerminals(id, target))
        .catch((error) => console.warn('[terminals] list failed', error));
    };
    read();
    if (!running) return;
    const timer = window.setInterval(read, RUNNING_TERMINALS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, directory, running]);
};
