/**
 * Keeps the marks extensions put on sidebar rows current while the app runs.
 *
 * A service sets a mark on the server, which announces the change on the
 * control stream with no payload; this hook reads the marks again then, and
 * when the stream reconnects, since a change made during the gap was not
 * announced to this client. It also reads when the catalog starts showing an
 * extension that may put marks, and asks the server nothing while there is
 * none. The store joins every answer with the catalog and the folders this
 * client knows, so a mark of an extension that was paused or lost its
 * approval is gone with the catalog change, before any read.
 */

import React from 'react';

import { reloadGuestMarks, stopGuestMarksRetry } from '@/lib/guests/load-marks';
import { mayGuestShowMarks, type GuestMarkPlace } from '@/lib/guests/marks';
import { useGuestMarksStore } from '@/lib/guests/marks-store';
import { useGuestsStore } from '@/lib/guests/store';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { normalizePath } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Project roots and worktree paths, each with its project: where a branch target's folder is looked up. */
const knownPlaces = (): GuestMarkPlace[] => {
  const places: GuestMarkPlace[] = [];
  const projectByPath = new Map<string, string>();
  for (const project of useProjectsStore.getState().projects) {
    const path = normalizePath(project.path);
    if (!path || projectByPath.has(path)) continue;
    projectByPath.set(path, project.id);
    places.push({ path, projectId: project.id });
  }
  for (const [projectPath, worktrees] of useSessionUIStore.getState().availableWorktreesByProject) {
    const projectId = projectByPath.get(normalizePath(projectPath) ?? '');
    if (!projectId) continue;
    for (const worktree of worktrees) {
      const path = normalizePath(worktree.path);
      if (path && !projectByPath.has(path)) places.push({ path, projectId });
    }
  }
  return places;
};

export const useGuestMarksSync = (): void => {
  React.useEffect(() => {
    // Which extensions of which server may show marks; a read follows each change of it.
    let showing = '';
    const followCatalog = (): void => {
      const { guests, runtimeKey } = useGuestsStore.getState();
      const ids = guests.filter(mayGuestShowMarks).map((guest) => guest.id);
      const next = ids.length > 0 ? JSON.stringify([runtimeKey, ids]) : '';
      const started = showing === '' && next !== '';
      const changed = next !== showing;
      showing = next;
      if (started) useGuestMarksStore.getState().setPlaces(knownPlaces());
      useGuestMarksStore.getState().setGuests(guests);
      if (!changed) return;
      if (next === '') stopGuestMarksRetry();
      else void reloadGuestMarks();
    };
    const followPlaces = (): void => {
      if (showing !== '') useGuestMarksStore.getState().setPlaces(knownPlaces());
    };
    followCatalog();
    const stops = [
      useGuestsStore.subscribe((state, previous) => {
        if (state.guests !== previous.guests || state.runtimeKey !== previous.runtimeKey) followCatalog();
      }),
      useProjectsStore.subscribe((state, previous) => {
        if (state.projects !== previous.projects) followPlaces();
      }),
      useSessionUIStore.subscribe((state, previous) => {
        if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) followPlaces();
      }),
      subscribeOpenchamberEvents((event) => {
        if (event.type !== 'guest-marks-changed' && event.type !== 'event-stream-ready') return;
        if (showing !== '') void reloadGuestMarks();
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      stopGuestMarksRetry();
    };
  }, []);
};
