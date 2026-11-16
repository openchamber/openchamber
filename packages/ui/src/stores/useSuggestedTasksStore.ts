import React from 'react';
import { create } from 'zustand';

import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getSuggestedTasksRuntime, subscribeSuggestedTasksRuntime, type SuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { useSuggestedTasksSettingsStore } from './useSuggestedTasksSettingsStore';
import {
  fetchSuggestionInbox,
  fetchSuggestionSummary,
  type Suggestion,
  type SuggestionInbox,
  type SuggestionSummary,
} from '@/lib/suggestedTasksApi';

/**
 * A project's inbox as the page shows it. A failed refresh keeps the inbox
 * it had and carries the error beside it, so a lost connection never reads
 * as "no suggestions".
 */
type InboxEntry =
  | { status: 'loading' }
  | { status: 'ready'; inbox: SuggestionInbox }
  | { status: 'error'; error: string; inbox: SuggestionInbox | null };

type SuggestedTasksState = {
  inboxes: Record<string, InboxEntry>;
  /** Last confirmed open counts; null until the first successful summary. */
  summary: SuggestionSummary | null;
  summaryError: string | null;
  loadInbox: (projectId: string, refresh?: boolean) => Promise<void>;
  loadSummary: () => Promise<void>;
  /** Puts a suggestion the server answered with in place, before the refresh the event triggers. */
  applySuggestion: (projectId: string, suggestion: Suggestion, runtime: SuggestedTasksRuntime) => void;
};

const inboxOf = (entry: InboxEntry | undefined): SuggestionInbox | null => (
  entry && entry.status !== 'loading' ? entry.inbox : null
);

export const useSuggestedTasksStore = create<SuggestedTasksState>((set, get) => {
  const loads = new Map<string, { promise: Promise<void>; refresh: boolean; mutations: Map<string, Suggestion> }>();
  let summaryRequest = 0;
  subscribeSuggestedTasksRuntime(() => {
    loads.clear();
    summaryRequest += 1;
    set({ inboxes: {}, summary: null, summaryError: null });
  });
  return {
  inboxes: {},
  summary: null,
  summaryError: null,
  loadInbox: (projectId, refresh = false) => {
    const pending = loads.get(projectId);
    if (pending) {
      if (refresh) pending.refresh = true;
      return pending.promise;
    }
    const runtime = getSuggestedTasksRuntime();
    if (!get().inboxes[projectId]) set((state) => ({ inboxes: { ...state.inboxes, [projectId]: { status: 'loading' } } }));
    const load = { promise: Promise.resolve(), refresh: false, mutations: new Map<string, Suggestion>() };
    load.promise = Promise.resolve().then(async () => {
      do {
        load.refresh = false;
        load.mutations.clear();
        try {
          const inbox = await fetchSuggestionInbox(projectId);
          if (runtime.signal.aborted) return;
          const suggestions = new Map(inbox.suggestions.map((suggestion) => [suggestion.id, suggestion]));
          for (const [id, suggestion] of load.mutations) suggestions.set(id, suggestion);
          set((state) => ({ inboxes: { ...state.inboxes, [projectId]: { status: 'ready', inbox: { ...inbox, suggestions: [...suggestions.values()] } } } }));
        } catch (error) {
          if (runtime.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({ inboxes: { ...state.inboxes, [projectId]: { status: 'error', error: message, inbox: inboxOf(state.inboxes[projectId]) } } }));
        }
      } while (load.refresh);
    }).finally(() => {
      if (loads.get(projectId) === load) loads.delete(projectId);
    });
    loads.set(projectId, load);
    return load.promise;
  },
  loadSummary: async () => {
    const runtime = getSuggestedTasksRuntime();
    const request = ++summaryRequest;
    try {
      const summary = await fetchSuggestionSummary();
      if (!runtime.signal.aborted && request === summaryRequest) set({ summary, summaryError: null });
    } catch (error) {
      if (!runtime.signal.aborted && request === summaryRequest) set({ summaryError: error instanceof Error ? error.message : String(error) });
    }
  },
  applySuggestion: (projectId, suggestion, runtime) => {
    if (runtime.signal.aborted) return;
    loads.get(projectId)?.mutations.set(suggestion.id, suggestion);
    set((state) => {
    const entry = state.inboxes[projectId];
    const inbox = inboxOf(entry);
    if (!entry || !inbox || entry.status === 'loading') return state;
    const suggestions = new Map(inbox.suggestions.map((current) => [current.id, current]));
    suggestions.set(suggestion.id, suggestion);
    return { inboxes: { ...state.inboxes, [projectId]: { ...entry, inbox: { ...inbox, suggestions: [...suggestions.values()] } } } };
    });
  },
  };
});

let listeners = 0;
let release: (() => void) | null = null;

/**
 * Keeps loaded inboxes and the summary current while something shows them:
 * a change event reloads the summary and that project's inbox, a new event
 * stream connection reloads everything loaded, and a runtime switch drops
 * what belonged to the previous server. Returns the release.
 */
export const observeSuggestedTasks = (): (() => void) => {
  listeners += 1;
  if (!release) {
    const releaseEvents = subscribeOpenchamberEvents((event) => {
      const store = useSuggestedTasksStore.getState();
      if (event.type === 'suggested-tasks-changed') {
        void store.loadSummary();
        if (store.inboxes[event.projectId]) void store.loadInbox(event.projectId, true);
        const settings = useSuggestedTasksSettingsStore.getState();
        if (settings.entries[event.projectId]) void settings.load(event.projectId);
      } else if (event.type === 'event-stream-ready') {
        void store.loadSummary();
        for (const projectId of Object.keys(store.inboxes)) void store.loadInbox(projectId, true);
        const settings = useSuggestedTasksSettingsStore.getState();
        for (const projectId of Object.keys(settings.entries)) void settings.load(projectId);
      }
    });
    const releaseRuntime = subscribeSuggestedTasksRuntime(() => {
      void useSuggestedTasksStore.getState().loadSummary();
    });
    release = () => {
      releaseEvents();
      releaseRuntime();
    };
  }
  return () => {
    listeners -= 1;
    if (listeners === 0 && release) {
      release();
      release = null;
    }
  };
};

/** Open suggestions across projects, observed only while a supported readout is visible. */
export const useOpenSuggestionCount = (enabled: boolean): number => {
  const active = enabled && !isVSCodeRuntime();
  const subscribe = React.useCallback((notify: () => void) => (
    active ? useSuggestedTasksStore.subscribe(notify) : () => undefined
  ), [active]);
  const snapshot = React.useCallback(() => (
    active ? useSuggestedTasksStore.getState().summary?.reduce((sum, project) => sum + (project.open ?? 0), 0) ?? 0 : 0
  ), [active]);
  const count = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  React.useEffect(() => {
    if (!active) return;
    const release = observeSuggestedTasks();
    void useSuggestedTasksStore.getState().loadSummary();
    return release;
  }, [active]);
  return count;
};
