import React from 'react';
import { create } from 'zustand';

import {
  fetchSessionKnowledgeSummary,
  setSessionProjectContextPin,
  type SessionProjectContextPins,
} from '@/lib/sessionKnowledgeApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';

const NO_PINS: SessionProjectContextPins = { notes: [], plans: [] };

const sessionKey = (directory: string | null, sessionId: string | null): string => `${getRuntimeKey()}\0${directory ?? ''}\0${sessionId ?? ''}`;

type SessionPinsEntry = { pins: SessionProjectContextPins; revision: number };

/**
 * The current session's pins, shared by everything that shows or toggles one:
 * the knowledge lists and an open plan's menu can be on screen together, and
 * a pin made in one has to show in the other.
 */
const usePinsStore = create<{ bySession: Record<string, SessionPinsEntry> }>(() => ({ bySession: {} }));

/**
 * Pins kept per session, each with the number of toggles made on it. A read
 * that started before a toggle answers with the state before it, so it is
 * dropped; a toggle that finishes after the user moved to another session
 * lands on its own session and leaves the shown one alone.
 */
const revisionOf = (key: string): number => usePinsStore.getState().bySession[key]?.revision ?? 0;
const writePins = (key: string, pins: SessionProjectContextPins, revision: number) => {
  usePinsStore.setState((state) => ({ bySession: { ...state.bySession, [key]: { pins, revision } } }));
};

/**
 * Which notes and plans the current session has pinned, and the toggle. A
 * new-session draft keeps its pins on the draft until its first message
 * creates the session.
 */
export const useSessionKnowledgePins = () => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
  const draftPins = useSessionUIStore((state) => state.newSessionDraft.projectContextPins);
  const setDraftProjectContextPin = useSessionUIStore((state) => state.setDraftProjectContextPin);
  const key = sessionKey(currentSessionDirectory, currentSessionId);

  // Every mount reads again: an agent may have pinned something since. The
  // summary request is cached and shared, so several readers cost one fetch.
  React.useEffect(() => {
    if (draftOpen) return;
    let cancelled = false;
    const startedAt = revisionOf(key);
    void fetchSessionKnowledgeSummary(currentSessionDirectory, currentSessionId).then((summary) => {
      if (cancelled || revisionOf(key) !== startedAt) return;
      writePins(key, { notes: summary.notes.map((note) => note.id), plans: summary.plans.map((plan) => plan.id) }, startedAt);
    });
    return () => { cancelled = true; };
  }, [currentSessionDirectory, currentSessionId, draftOpen, key]);

  const storedPins = usePinsStore((state) => state.bySession[key]?.pins ?? NO_PINS);
  const pins = draftOpen ? draftPins ?? NO_PINS : storedPins;

  const togglePin = React.useCallback(async (kind: 'note' | 'plan', id: string, pinned: boolean) => {
    if (draftOpen) {
      setDraftProjectContextPin(kind, id, pinned);
      return true;
    }
    if (!currentSessionId || !currentSessionDirectory) return false;
    const next = await setSessionProjectContextPin(currentSessionDirectory, currentSessionId, kind, id, pinned);
    if (!next) return false;
    writePins(key, next, revisionOf(key) + 1);
    return true;
  }, [currentSessionDirectory, currentSessionId, draftOpen, key, setDraftProjectContextPin]);

  const pinnedNoteIds = React.useMemo(() => new Set(pins.notes), [pins.notes]);
  const pinnedPlanIds = React.useMemo(() => new Set(pins.plans), [pins.plans]);
  return { pinnedNoteIds, pinnedPlanIds, togglePin };
};
