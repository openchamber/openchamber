
import { listIntegrateCheckouts } from '@/lib/worktrees/integrateCheckouts';
import React from 'react';

import { reloadGuestMarks, stopGuestMarksRetry } from '@/lib/guests/load-marks';
import { mayGuestShowMarks, type GuestMarkPlace } from '@/lib/guests/marks';
import { useGuestMarksStore } from '@/lib/guests/marks-store';
import { useGuestsStore } from '@/lib/guests/store';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { normalizePath } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

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
  for (const checkout of listIntegrateCheckouts()) {
    const projectId = checkout.projectPaths.flatMap((path) => projectByPath.get(path) ?? [])[0];
    if (projectId) places.push({ path: checkout.path, projectId });
  }
  return places;
};

export const useGuestMarksSync = (): void => {
  React.useEffect(() => {
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
