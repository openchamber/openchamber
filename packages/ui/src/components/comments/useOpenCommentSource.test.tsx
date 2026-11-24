import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { RuntimeAPIs } from '@/lib/api/types';
import type { MobileAppActions } from '@/apps/mobileAppContext';
import { DedicatedMobileAppProvider } from '@/apps/mobileAppContext';
import { ChatColumnSessionContext } from '@/components/chat/chatColumnSession';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n';
import { markMiniChatWindow } from '@/lib/miniChatWindow';
import { getRuntimeKey } from '@/lib/runtime-switch';
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
let source: ReturnType<typeof useOpenCommentSource>;

const Probe = () => {
    source = useOpenCommentSource('/repo');
    return null;
};

const SESSION = { sessionId: 'ses_1', directory: '/repo' };

const render = async (runtime: RuntimeAPIs, mobile?: MobileAppActions) => {
    const probe = <ChatColumnSessionContext.Provider value={SESSION}><Probe /></ChatColumnSessionContext.Provider>;
    await act(async () => root.render(
        <I18nProvider><RuntimeAPIContext.Provider value={runtime}>
            {mobile ? <DedicatedMobileAppProvider actions={mobile}>{probe}</DedicatedMobileAppProvider> : probe}
        </RuntimeAPIContext.Provider></I18nProvider>,
    ));
};

const webAPIs = async () => (await import('../../../../web/src/api/index')).createWebAPIs();
const vscodeAPIs = async (opened: Array<[string, number | undefined]>): Promise<RuntimeAPIs> => {
    const web = await webAPIs();
    return {
        ...web,
        runtime: { ...web.runtime, platform: 'vscode', isVSCode: true },
        editor: {
            openFile: async (path: string, line?: number) => { opened.push([path, line]); },
            openDiff: async () => undefined,
        },
    };
};
const mobileActions = (opened: string[]): MobileAppActions => ({
    openChanges: () => { opened.push('changes'); },
    openFiles: () => { opened.push('files'); },
    openSourceBoard: () => undefined,
    openPlan: () => undefined,
    openReceivedPage: () => undefined,
});

const tabs = () => useUIStore.getState().contextPanelByDirectory['/repo']?.tabs ?? [];
const checkout = (branch: string) => useGitStore.getState().restoreStatus('/repo', {
    current: branch, tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
});

beforeEach(async () => {
    const { createRoot } = await import('react-dom/client');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useUIStore.setState({ contextPanelByDirectory: {}, pendingFileNavigation: null, pendingCommentLocation: null, pendingTurnDiffFile: null });
    usePullRequestSelectionStore.setState({ diffRequests: new Map() });
    useGitBaseBranchStore.setState({ overrides: {} });
    useGitStore.getState().setActiveDirectory('/repo');
    checkout('feature');
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

test('a comment on uncommitted changes opens the file at its line', async () => {
    await render(await webAPIs());

    for (const origin of [undefined, { kind: 'working-tree' as const }]) {
        expect(source.canOpen({ source: 'diff', origin })).toBe(true);
        await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 12, origin }));
        expect(tabs().at(-1)).toMatchObject({ mode: 'file', targetPath: '/repo/src/app.ts' });
        expect(useUIStore.getState().pendingFileNavigation).toEqual({ path: '/repo/src/app.ts', line: 12, column: 1 });
    }
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
});

test('a comparison comment hands the git tab its whole comparison and line', async () => {
    await render(await webAPIs());
    const origin = { kind: 'change-request' as const, provider: 'github' as const, number: 42, repository: 'team/project', revision: 'abc' };

    await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 9, side: 'original', origin }));

    expect(tabs().at(-1)).toMatchObject({ mode: 'git', targetPath: 'src/app.ts', diffScope: 'pr' });
    expect(useUIStore.getState().pendingCommentLocation).toEqual({
        runtimeKey: getRuntimeKey(), directory: '/repo', filePath: 'src/app.ts', line: 9, side: 'deletions', origin,
    });
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
});

test("a branch comment never rewrites the branch's saved base, and needs that branch checked out", async () => {
    await render(await webAPIs());
    const origin = { kind: 'branch' as const, baseRef: 'refs/heads/main', headRef: 'feature' };

    expect(source.canOpen({ source: 'diff', origin })).toBe(true);
    await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 3, origin }));
    expect(useGitBaseBranchStore.getState().getOverride('/repo', 'feature')).toBeNull();
    expect(tabs().at(-1)).toMatchObject({ mode: 'git', diffScope: 'branch' });
    expect(useUIStore.getState().pendingCommentLocation).toMatchObject({ filePath: 'src/app.ts', line: 3, side: 'additions', origin });

    // The branch scope compares the checkout, so another branch's lines are not there.
    await act(async () => checkout('other'));
    expect(source.canOpen({ source: 'diff', origin })).toBe(false);
});

test('a turn comment opens that turn, and offers nothing when the turn is unknown', async () => {
    await render(await webAPIs());

    expect(source.canOpen({ source: 'diff', origin: { kind: 'turn' } })).toBe(false);
    const origin = { kind: 'turn' as const, turnId: 'msg_7' };
    expect(source.canOpen({ source: 'diff', origin })).toBe(true);
    await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 5, origin }));

    expect(useUIStore.getState().pendingTurnDiffFile).toMatchObject({ file: 'src/app.ts', sessionId: 'ses_1', turnId: 'msg_7' });
    expect(tabs().at(-1)).toMatchObject({ mode: 'git', diffScope: 'turn' });
    // Never a branch comparison.
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
});

test('VS Code opens a file comment in its editor, and offers no comparison it cannot show', async () => {
    const opened: Array<[string, number | undefined]> = [];
    await render(await vscodeAPIs(opened));

    await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 7, origin: { kind: 'working-tree' } }));

    expect(opened).toEqual([['/repo/src/app.ts', 7]]);
    expect(tabs()).toEqual([]);
    expect(source.canOpen({ source: 'diff', origin: { kind: 'working-tree', staged: true } })).toBe(true);
    expect(source.canOpen({ source: 'diff', origin: { kind: 'commit', hash: 'b'.repeat(40) } })).toBe(false);
    expect(source.canOpen({ source: 'plan' })).toBe(false);
});

test("the phone's Changes takes a comparison comment, and Files a file comment", async () => {
    const opened: string[] = [];
    await render(await webAPIs(), mobileActions(opened));

    await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 4, origin: { kind: 'commit', hash: 'a'.repeat(40) } }));
    await act(async () => source.open({ fileLabel: 'src/app.ts', startLine: 4 }));

    expect(opened).toEqual(['changes', 'files']);
    expect(useUIStore.getState().pendingCommentLocation).toMatchObject({ directory: '/repo', filePath: 'src/app.ts', line: 4 });
});

// Last: the mini chat flag stays set for the rest of the process.
test('the mini chat, which has no file or diff viewer, offers no opener', async () => {
    markMiniChatWindow();
    await render(await webAPIs());

    expect(source.canOpen({ source: 'diff' })).toBe(false);
    expect(source.canOpen({ source: 'diff', origin: { kind: 'commit', hash: 'a'.repeat(40) } })).toBe(false);
});
