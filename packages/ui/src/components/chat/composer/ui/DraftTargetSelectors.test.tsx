import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { themes } from '@/lib/theme/themes';

import type { DraftTargetProject } from '../state/useDraftTarget';
import { sessionEvents } from '@/lib/sessionEvents';
import { MobileDraftTargetSheets } from './DraftTargetSelectors';

const project: DraftTargetProject = { id: 'p1', path: '/repo', label: 'repo', kind: 'project' };

const renderBranchSheet = (onCreateCustomWorktree?: () => void) => renderSheet('branch', onCreateCustomWorktree);

const renderSheet = async (openPicker: 'project' | 'branch', onCreateCustomWorktree?: () => void) => {
    const win = new Window({ url: 'http://localhost' });
    const values = {
        window: win,
        document: win.document, Event: win.Event, CustomEvent: win.CustomEvent,
        navigator: win.navigator,
        localStorage: win.localStorage,
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let pickerChanges = 0;
    let pickerOpen: string | null = openPicker;
    await act(async () => root.render(
        <I18nProvider>
            <MobileDraftTargetSheets
                projects={[project]}
                selectedProject={project}
                selectedDirectory="/repo"
                selectedBranchLabel="main"
                selectedBranchIsKnown
                hasUncommittedChanges={false}
                projectRootBranchOption={{ value: '/repo', label: 'main' }}
                worktreeBranchOptions={[]}
                spaceBranchOptions={[]}
                branchItems={[{ value: '/repo', label: 'main' }]}
                showBranchSelector
                onProjectChange={() => {}}
                onDirectoryChange={() => {}}
                onCreateCustomWorktree={onCreateCustomWorktree}
                theme={themes[0]}
                openPicker={openPicker}
                onOpenPickerChange={(next) => { pickerChanges += 1; pickerOpen = next; }}
            />
        </I18nProvider>,
    ));
    const button = (label: string) => [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === label) ?? null;
    return { root, button, picker: () => ({ changes: pickerChanges, open: pickerOpen }) };
};

describe('draft worktree actions', () => {
    test('offer a quick worktree and the dialog, and the dialog entry closes the sheet', async () => {
        let opened = 0;
        const { root, picker, button } = await renderBranchSheet(() => { opened += 1; });
        expect(button('Quick worktree')).not.toBeNull();
        const custom = button('New worktree…');
        expect(custom).not.toBeNull();
        await act(async () => { custom?.click(); });
        expect(opened).toBe(1);
        expect(picker()).toEqual({ changes: 1, open: null });
        await act(async () => root.unmount());
    });

    test('leave the dialog entry out where the draft cannot open it', async () => {
        const { root, button } = await renderBranchSheet();
        expect(button('Quick worktree')).not.toBeNull();
        expect(button('New worktree…')).toBeNull();
        await act(async () => root.unmount());
    });
});

describe('draft project picker', () => {
    test('ends with Add project…, which closes the sheet and asks for a folder', async () => {
        let requested = 0;
        const stop = sessionEvents.onDirectoryRequest(() => { requested += 1; });
        const { root, picker, button } = await renderSheet('project');
        const add = button('Add project…');
        expect(add).not.toBeNull();
        await act(async () => { add?.click(); });
        expect(requested).toBe(1);
        expect(picker()).toEqual({ changes: 1, open: null });
        stop();
        await act(async () => root.unmount());
    });
});
