import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { RuntimeAPIs } from '@/lib/api/types';
import type { MobileAppActions } from '@/apps/mobileAppContext';
import { DedicatedMobileAppProvider } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitStore } from '@/stores/useGitStore';
import { usePullRequestSelectionStore } from '@/stores/usePullRequestSelectionStore';
import { useUIStore } from '@/stores/useUIStore';

import { useOpenCommentSource } from './useOpenCommentSource';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    customElements: browser.customElements,
    CSSStyleSheet: browser.CSSStyleSheet,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
});

let root: ReturnType<typeof import('react-dom/client')['createRoot']>;
let container: HTMLDivElement;
let open: ReturnType<typeof useOpenCommentSource>['open'];
let canOpen: ReturnType<typeof useOpenCommentSource>['canOpen'];

const Probe = () => {
    const source = useOpenCommentSource();
    open = source.open;
    canOpen = source.canOpen;
    return null;
};

const render = async (runtime: RuntimeAPIs, mobile?: MobileAppActions) => {
    const tree = (
        <RuntimeAPIContext.Provider value={runtime}>
            {mobile ? <DedicatedMobileAppProvider actions={mobile}><Probe /></DedicatedMobileAppProvider> : <Probe />}
        </RuntimeAPIContext.Provider>
    );
    await act(async () => root.render(tree));
};

const tabs = () => useUIStore.getState().contextPanelByDirectory['/repo']?.tabs ?? [];

beforeEach(async () => {
    const { createRoot } = await import('react-dom/client');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useUIStore.setState({ contextPanelByDirectory: {}, pendingFileNavigation: null, pendingCommentLocation: null });
    usePullRequestSelectionStore.setState({ diffRequests: new Map() });
    useGitStore.getState().setActiveDirectory('/repo');
    useGitStore.getState().restoreStatus('/repo', {
        current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
    });
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

test('a plain file comment opens the file at its line', async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    const mobile: MobileAppActions = { openFiles: () => undefined, openChanges: () => undefined, openSourceBoard: () => undefined, openPlan: () => undefined, openReceivedPage: () => undefined };
    await render(createWebAPIs(), mobile);

    await act(async () => open('/repo', { fileLabel: 'src/app.ts', startLine: 12 }));

    expect(tabs().at(-1)).toMatchObject({ mode: 'file', targetPath: '/repo/src/app.ts' });
    expect(useUIStore.getState().pendingFileNavigation).toEqual({ path: '/repo/src/app.ts', line: 12, column: 1 });
    // The phone's viewer lives in the workspace drawer.
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
});

test('a comparison comment opens its diff, never the file on disk', async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    await render(createWebAPIs());

    await act(async () => open('/repo', {
        fileLabel: 'src/app.ts', startLine: 9, side: 'original',
        origin: { kind: 'change-request', provider: 'github', number: 42, repository: 'team/project' },
    }));

    expect(usePullRequestSelectionStore.getState().diffRequests.get('/repo'))
        .toEqual({ kind: 'pr', number: 42, sourceRepo: { owner: 'team', repo: 'project' } });
    expect(tabs().at(-1)).toMatchObject({ mode: 'diff', targetPath: 'src/app.ts', diffScope: 'pr' });
    expect(useUIStore.getState().pendingCommentLocation).toEqual({
        directory: '/repo', filePath: 'src/app.ts', line: 9, side: 'deletions',
        origin: { kind: 'change-request', provider: 'github', number: 42, repository: 'team/project' },
    });
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
});

test('a branch comment compares against the base it was written on', async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    await render(createWebAPIs());

    await act(async () => open('/repo', {
        fileLabel: 'src/app.ts', startLine: 3,
        origin: { kind: 'branch', baseRef: 'refs/heads/main', headRef: 'feature' },
    }));

    expect(useGitBaseBranchStore.getState().getOverride('/repo', 'feature')).toBe('refs/heads/main');
    expect(tabs().at(-1)).toMatchObject({ mode: 'diff', diffScope: 'branch' });
    expect(useUIStore.getState().pendingCommentLocation).toMatchObject({ directory: '/repo', filePath: 'src/app.ts', line: 3, side: 'additions' });
});

test('a branch comment of a branch that is not checked out keeps its base and names no line', async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    useGitStore.getState().restoreStatus('/repo', {
        current: 'other', tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
    });
    await render(createWebAPIs());

    await act(async () => open('/repo', {
        fileLabel: 'src/app.ts', startLine: 3,
        origin: { kind: 'branch', baseRef: 'refs/heads/main', headRef: 'feature' },
    }));

    // The base stays with the branch it was picked on, and the branch scope
    // compares the checkout, so there is no such line to name.
    expect(useGitBaseBranchStore.getState().getOverride('/repo', 'feature')).toBe('refs/heads/main');
    expect(useGitBaseBranchStore.getState().getOverride('/repo', 'other')).toBeNull();
    expect(tabs().at(-1)).toMatchObject({ mode: 'diff', diffScope: 'branch', targetPath: 'src/app.ts' });
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
});

test('a commit comment names the commit its diff shows', async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    await render(createWebAPIs());

    await act(async () => open('/repo', {
        fileLabel: 'src/app.ts', startLine: 1,
        origin: { kind: 'commit', hash: 'a'.repeat(40) },
    }));

    expect(tabs().at(-1)).toMatchObject({ mode: 'diff', diffScope: 'commit' });
    expect(useUIStore.getState().pendingCommentLocation).toMatchObject({
        line: 1, side: 'additions', origin: { kind: 'commit', hash: 'a'.repeat(40) },
    });
});

test('VS Code opens a file comment in its editor, and offers no comparison it cannot show', async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    const opened: Array<[string, number | undefined]> = [];
    const web = createWebAPIs();
    const runtime: RuntimeAPIs = {
        ...web,
        runtime: { ...web.runtime, platform: 'vscode', isVSCode: true },
        editor: {
            openFile: async (path: string, line?: number) => { opened.push([path, line]); },
            openDiff: async () => undefined,
        },
    };
    await render(runtime);

    await act(async () => open('/repo', { fileLabel: 'src/app.ts', startLine: 7 }));

    expect(opened).toEqual([['/repo/src/app.ts', 7]]);
    expect(tabs()).toEqual([]);
    expect(canOpen({ source: 'diff' })).toBe(true);
    expect(canOpen({ source: 'diff', origin: { kind: 'commit', hash: 'b'.repeat(40) } })).toBe(false);
    expect(canOpen({ source: 'plan' })).toBe(false);
    // A comment written in another editor reached this one with its comparison.
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
});

test("the phone's Changes surface takes the comment's place", async () => {
    const { createWebAPIs } = await import('../../../../web/src/api/index');
    const opened: number[] = [];
    const mobile: MobileAppActions = {
        openChanges: () => { opened.push(1); },
        openFiles: () => undefined,
        openSourceBoard: () => undefined,
        openPlan: () => undefined,
        openReceivedPage: () => undefined,
    };
    await render(createWebAPIs(), mobile);

    await act(async () => open('/repo', {
        fileLabel: 'src/app.ts', startLine: 4,
        origin: { kind: 'branch', baseRef: 'refs/heads/main', headRef: 'feature' },
    }));

    expect(opened).toEqual([1]);
    expect(useUIStore.getState().pendingCommentLocation).toMatchObject({ directory: '/repo', filePath: 'src/app.ts', line: 4 });
});
