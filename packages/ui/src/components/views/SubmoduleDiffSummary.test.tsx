import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { GitSubmoduleState } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';

import { SubmoduleDiffSummary } from './SubmoduleDiffSummary';

const state = (overrides: Partial<GitSubmoduleState> = {}): GitSubmoduleState => ({
    headCommit: 'aaaaaaaaaaaa',
    indexCommit: 'aaaaaaaaaaaa',
    worktreeCommit: 'bbbbbbbbbbbb',
    hasConflict: false,
    hasTrackedChanges: false,
    hasUntrackedFiles: false,
    ...overrides,
});

const render = (overrides: Partial<GitSubmoduleState>): string =>
    renderToStaticMarkup(
        <I18nProvider>
            <SubmoduleDiffSummary state={state(overrides)} staged={false} />
        </I18nProvider>,
    );

describe('SubmoduleDiffSummary', () => {
    test('shows the recorded commit without changing the repository selection', () => {
        const markup = render({});

        expect(markup).not.toContain('View this repository');
    });

    test('renders no button when the submodule is not checked out', () => {
        const markup = render({ worktreeCommit: null });

        expect(markup).toContain('Not checked out');
        expect(markup).not.toContain('View this repository');
    });

    test('shows uncommitted work without changing the repository selection', () => {
        const markup = render({ hasTrackedChanges: true, hasUntrackedFiles: true });

        expect(markup).toContain('Has uncommitted changes');
        expect(markup).not.toContain('View this repository');
    });
});
