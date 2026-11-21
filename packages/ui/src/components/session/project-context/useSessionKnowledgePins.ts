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

const usePinsStore = create<{ bySession: Record<string, SessionPinsEntry> }>(() => ({ bySession: {} }));

const revisionOf = (key: string): number => usePinsStore.getState().bySession[key]?.revision ?? 0;
const writePins = (key: string, pins: SessionProjectContextPins, revision: number) => {
  usePinsStore.setState((state) => ({ bySession: { ...state.bySession, [key]: { pins, revision } } }));
};

export const useSessionKnowledgePins = () => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
  const draftPins = useSessionUIStore((state) => state.newSessionDraft.projectContextPins);
  const setDraftProjectContextPin = useSessionUIStore((state) => state.setDraftProjectContextPin);
  const key = sessionKey(currentSessionDirectory, currentSessionId);

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
