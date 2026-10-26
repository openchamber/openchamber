import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { focusChatInput } from './composer/editor/dom';

/**
 * The session the chat column is showing — the deferred selection the
 * timeline renders, not the live store value. The composer and everything
 * stacked with the timeline read it so the column changes as one: a session
 * click publishes the live selection first, and a composer that followed it
 * would change height (changed-files row, todos, queued chips) while the
 * outgoing timeline is still on screen, shoving that timeline before the swap.
 */
export type ChatColumnSession = {
  sessionId: string | null;
  directory: string | null;
};

export const ChatColumnSessionContext = React.createContext<ChatColumnSession | null>(null);

export const useChatColumnSession = (): ChatColumnSession | null => React.useContext(ChatColumnSessionContext);

/**
 * The session a chat component acts on: its column's when it renders inside
 * one, the app's selection elsewhere. Outside a column it reads the live
 * selection; inside one it never subscribes to it, so a pinned column (the
 * side panel) does not re-render when the main chat switches sessions.
 */
export const useChatSessionSelection = (): ChatColumnSession => {
  const column = useChatColumnSession();
  const liveSessionId = useSessionUIStore((state) => (column ? null : state.currentSessionId));
  const liveDirectory = useSessionUIStore((state) => (column ? null : state.currentSessionDirectory));
  return React.useMemo(
    () => column ?? { sessionId: liveSessionId, directory: liveDirectory },
    [column, liveDirectory, liveSessionId],
  );
};

/**
 * What a column does on behalf of the chat inside it. The app's main chat
 * acts on the global selection and the global panels; a pinned column (a chat
 * opened in the side panel) keeps its own session, navigates inside itself,
 * and leaves the main chat's selection and panels alone.
 */
export type ChatColumnActions = {
  pinned: boolean;
  openSession: (sessionId: string, directory: string | null) => void;
  openTimelineDialog: () => void;
  /** Focuses this column's composer, never another chat's. */
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

/**
 * Whether the composer is expanded to fill the column (focus mode). Only the
 * main chat has it, as an app-wide preference toggled by the `expand_input`
 * shortcut; a pinned column's composer never expands, so the shortcut leaves
 * the side panel as it was.
 */
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
