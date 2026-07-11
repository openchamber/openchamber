import { afterEach, describe, expect, test } from 'bun:test';

import {
    cancelPendingSidebarVisualSelection,
    notifySidebarVisualSelectionCommitted,
    requestSidebarVisualSelection,
    syncSidebarVisualSelection,
    useSidebarVisualSelectionStore,
} from './sidebarVisualSelection';
import { announceSessionSwitchIntent } from '@/lib/sessionSwitchIntent';
import {
    getSessionFocusKey,
    isSessionFocusEqual,
    type SessionFocusIdentity,
} from '@/stores/useSessionFocusStore';

const recentFocus = (sessionId: string, projectId = 'project-a'): SessionFocusIdentity => ({
    scope: 'recent',
    sessionId,
    projectId,
});

const projectFocus = (sessionId: string, projectId = 'project-a'): SessionFocusIdentity => ({
    scope: 'project',
    sessionId,
    projectId,
});

afterEach(() => {
    cancelPendingSidebarVisualSelection();
    announceSessionSwitchIntent(null);
    syncSidebarVisualSelection(null);
});

describe('sidebarVisualSelection', () => {
    test('commits authority only after the exact focused row reports a DOM commit', () => {
        let commits = 0;
        const focus = recentFocus('session-a');
        requestSidebarVisualSelection(focus, () => {
            commits += 1;
        });

        expect(useSidebarVisualSelectionStore.getState().focus).toEqual(focus);
        expect(commits).toBe(0);

        notifySidebarVisualSelectionCommitted(projectFocus('session-a'));
        expect(commits).toBe(0);

        notifySidebarVisualSelectionCommitted(focus);
        expect(commits).toBe(1);
    });

    test('cancels an intermediate selection during rapid switching', () => {
        const commits: string[] = [];
        const focusA = recentFocus('session-a');
        const focusB = recentFocus('session-b');
        requestSidebarVisualSelection(focusA, () => commits.push('session-a'));
        requestSidebarVisualSelection(focusB, () => commits.push('session-b'));

        notifySidebarVisualSelectionCommitted(focusA);
        expect(commits).toEqual([]);

        notifySidebarVisualSelectionCommitted(focusB);
        expect(commits).toEqual(['session-b']);
    });

    test('treats two sidebar occurrences of the same session as different focus targets', () => {
        const commits: string[] = [];
        const recent = recentFocus('session-a');
        const project = projectFocus('session-a');
        requestSidebarVisualSelection(recent, () => commits.push('recent'));
        requestSidebarVisualSelection(project, () => commits.push('project'));

        notifySidebarVisualSelectionCommitted(recent);
        expect(commits).toEqual([]);

        notifySidebarVisualSelectionCommitted(project);
        expect(commits).toEqual(['project']);
    });

    test('a newer direct navigation intent invalidates pending selection and defaults to project focus', () => {
        const commits: string[] = [];
        const focus = recentFocus('session-b');
        requestSidebarVisualSelection(focus, () => commits.push('session-b'));

        announceSessionSwitchIntent('session-c');
        notifySidebarVisualSelectionCommitted(focus);

        expect(commits).toEqual([]);
        expect(useSidebarVisualSelectionStore.getState().focus).toEqual({
            scope: 'project',
            sessionId: 'session-c',
            projectId: null,
        });
    });

    test('same-session direct intent and legacy sync preserve the current focus scope', () => {
        const focus = recentFocus('session-a');
        syncSidebarVisualSelection(focus);

        announceSessionSwitchIntent('session-a');
        syncSidebarVisualSelection('session-a');

        expect(useSidebarVisualSelectionStore.getState().focus).toEqual(focus);
    });

    test('focus equality and keys include the rendered scope and project', () => {
        const recent = recentFocus('session-a');
        const project = projectFocus('session-a');

        expect(isSessionFocusEqual(recent, { ...recent })).toBe(true);
        expect(isSessionFocusEqual(recent, project)).toBe(false);
        expect(getSessionFocusKey(recent)).toBe('recent:project-a:session-a');
        expect(getSessionFocusKey(project)).toBe('project:project-a:session-a');
    });
});
