import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { focusChatInput } from './composer/editor/dom';

export type ChatColumnSession = {
  sessionId: string | null;
  directory: string | null;
};

export const ChatColumnSessionContext = React.createContext<ChatColumnSession | null>(null);

export const useChatColumnSession = (): ChatColumnSession | null => React.useContext(ChatColumnSessionContext);

export const useChatSessionSelection = (): ChatColumnSession => {
  const column = useChatColumnSession();
  const liveSessionId = useSessionUIStore((state) => (column ? null : state.currentSessionId));
  const liveDirectory = useSessionUIStore((state) => (column ? null : state.currentSessionDirectory));
  return React.useMemo(
    () => column ?? { sessionId: liveSessionId, directory: liveDirectory },
    [column, liveDirectory, liveSessionId],
  );
};

export const ChatTranscriptDirectoryContext = React.createContext<string | null>(null);

export const useChatTranscriptDirectory = (): string | null => {
  const nested = React.useContext(ChatTranscriptDirectoryContext);
  const { directory } = useChatSessionSelection();
  return nested ?? directory;
};

export type ChatColumnActions = {
  pinned: boolean;
  openSession: (sessionId: string, directory: string | null) => void;
  openTimelineDialog: () => void;
  focusInput: () => void;
};

const MAIN_COLUMN_ACTIONS: ChatColumnActions = {
  pinned: false,
  openSession: (sessionId, directory) => useSessionUIStore.getState().setCurrentSession(sessionId, directory),
  openTimelineDialog: () => useUIStore.getState().setTimelineDialogOpen(true),
  focusInput: focusChatInput,
};

export const ChatColumnActionsContext = React.createContext<ChatColumnActions>(MAIN_COLUMN_ACTIONS);

export const useChatColumnActions = (): ChatColumnActions => React.useContext(ChatColumnActionsContext);

type ChatColumnExpandedInput = {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
};

const PINNED_COLUMN_EXPANDED_INPUT: ChatColumnExpandedInput = {
  expanded: false,
  setExpanded: () => {},
};

export const useChatColumnExpandedInput = (): ChatColumnExpandedInput => {
  const { pinned } = useChatColumnActions();
  const globalExpanded = useUIStore((state) => (pinned ? false : state.isExpandedInput));
  const setGlobalExpanded = useUIStore((state) => state.setExpandedInput);
  return React.useMemo(
    () => (pinned ? PINNED_COLUMN_EXPANDED_INPUT : { expanded: globalExpanded, setExpanded: setGlobalExpanded }),
    [pinned, globalExpanded, setGlobalExpanded],
  );
};
