import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '../child-store';
import { setActionRefs } from '../session-actions';
import { createEventRoutingIndex, handleEvent } from '../sync-context';
import { refreshSessionRecord, useSessionRecordDemand, useSessionRecordRefresh } from '../use-sync';

const DIRECTORY = '/repo';
const SESSION_ID = 'ses_record';

type RecordCall = { sessionID: string; directory?: string };
type Refresh = (sessionID: string, directory?: string) => Promise<void>;

const DOM_GLOBAL_NAMES = [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
    const window = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    const values = {
        window,
        document: window.document,
        navigator: window.navigator,
        Node: window.Node,
        Element: window.Element,
        HTMLElement: window.HTMLElement,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const name of DOM_GLOBAL_NAMES) {
        Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }
    return {
        window,
        restore: () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

describe('useSessionRecordRefresh', () => {
    let dom: Window;
    let restoreDom: () => void;
    let root: Root;
    let calls: RecordCall[];

    const refresh: Refresh = async (sessionID, directory) => {
        calls.push({ sessionID, directory });
    };

    type View = {
        sessionID?: string | null;
        contextSourcesShown?: boolean;
        ownsContextSources?: boolean;
        hasSnapshot?: boolean;
    };

    const Harness = ({ sessionID = SESSION_ID, contextSourcesShown = true, ownsContextSources = true, hasSnapshot = true }: View) => {
        useSessionRecordDemand(sessionID, contextSourcesShown);
        useSessionRecordRefresh({ sessionID, directory: DIRECTORY, ownsContextSources, hasRenderableSnapshot: hasSnapshot }, refresh);
        return null;
    };

    const render = async (view: View = {}) => {
        await act(async () => {
            root.render(<Harness {...view} />);
        });
    };

    const read = { sessionID: SESSION_ID, directory: DIRECTORY };

    beforeEach(() => {
        calls = [];
        const installed = installDom();
        dom = installed.window;
        restoreDom = installed.restore;
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        restoreDom();
        await dom.happyDOM.close();
    });

    test('reads a warm session once when its Context sources are shown', async () => {
        await render();
        await render();

        expect(calls).toEqual([read]);
    });

    test('does not read while Context sources are hidden, and reads once they are shown', async () => {
        await render({ contextSourcesShown: false });
        expect(calls).toEqual([]);

        await render();
        expect(calls).toEqual([read]);
    });

    test('a column that does not show Work Status, or is inactive, does not read', async () => {
        await render({ ownsContextSources: false });

        expect(calls).toEqual([]);
    });

    test('a cold open leaves the record to the session load, also once the snapshot becomes renderable', async () => {
        await render({ hasSnapshot: false });
        await render();

        expect(calls).toEqual([]);
    });

    test('leaving for a draft and coming back reads the session again', async () => {
        await render();
        await render({ sessionID: null });
        await render();

        expect(calls).toEqual([read, read]);
    });

    test('hiding Context sources ends the visit, so showing them again reads again', async () => {
        await render();
        await render({ contextSourcesShown: false });
        await render();

        expect(calls).toEqual([read, read]);
    });
});

describe('refreshSessionRecord', () => {
    const cleanups: Array<() => void> = [];
    let run = 0;

    afterEach(() => {
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    });

    const links = (ids: string[]) => ({ openchamber: { linked_issues: ids } });

    const record = (directory: string, ids: string[]): Session => ({
        id: SESSION_ID,
        projectID: 'prj_1',
        directory,
        title: 'Linked',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
        metadata: links(ids),
    });

    const setup = (ids: string[]) => {
        run += 1;
        const directory = `/record-refresh-${run}`;
        const childStores = new ChildStoreManager();
        const store = childStores.ensureChild(directory, { bootstrap: false });
        store.setState({ session: [record(directory, ids)], sessionTotal: 1 });
        setActionRefs(childStores, () => directory);
        const routingIndex = createEventRoutingIndex();
        const unscoped = spyOn(opencodeClient, 'getSessionUnscoped').mockRejectedValue(new Error('not found'));
        cleanups.push(() => {
            unscoped.mockRestore();
            childStores.disposeAll();
        });
        const receive = (event: SyncEvent) => handleEvent(directory, event, childStores, routingIndex, getRuntimeKey());
        const start = () => refreshSessionRecord({ childStores, sessionID: SESSION_ID, directory, runtimeKey: getRuntimeKey() });
        return { directory, store, receive, start };
    };

    const holdGetSession = () => {
        let resolve: (session: Session) => void = () => undefined;
        let reject: (error: Error) => void = () => undefined;
        const response = new Promise<Session>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const getSession = spyOn(opencodeClient, 'getSession').mockImplementation(() => response);
        cleanups.push(() => getSession.mockRestore());
        return { getSession, resolve, reject };
    };

    test('replaces a stale record with the server copy', async () => {
        const { directory, store, start } = setup(['#1']);
        const transport = holdGetSession();

        const done = start();
        transport.resolve(record(directory, ['#1', '#2']));
        await done;

        expect(transport.getSession).toHaveBeenCalledTimes(1);
        expect(store.getState().session[0]?.metadata).toEqual(links(['#1', '#2']));
    });

    test('keeps a newer link that a live event applied while the read was in flight', async () => {
        const { directory, store, receive, start } = setup(['#1']);
        const transport = holdGetSession();

        const done = start();
        for (let tick = 0; tick < 20 && transport.getSession.mock.calls.length === 0; tick += 1) await Promise.resolve();
        expect(transport.getSession).toHaveBeenCalledTimes(1);
        receive({
            type: 'session.patched',
            properties: { sessionID: SESSION_ID, patch: { metadata: links(['#1', '#3']) } },
        });
        transport.resolve(record(directory, ['#1']));
        await done;

        expect(store.getState().session[0]?.metadata).toEqual(links(['#1', '#3']));
    });

    const waitForRead = async (transport: ReturnType<typeof holdGetSession>) => {
        for (let tick = 0; tick < 20 && transport.getSession.mock.calls.length === 0; tick += 1) await Promise.resolve();
        expect(transport.getSession).toHaveBeenCalledTimes(1);
    };

    test('takes the fetched link when only usage changed while the read was in flight', async () => {
        const { directory, store, receive, start } = setup(['#1']);
        const transport = holdGetSession();

        const done = start();
        await waitForRead(transport);
        receive({
            type: 'session.patched',
            properties: { sessionID: SESSION_ID, patch: { cost: 5, time: { created: 1, updated: 9 } } },
        });
        transport.resolve(record(directory, ['#1', '#2']));
        await done;

        const shown = store.getState().session[0];
        expect(shown?.metadata).toEqual(links(['#1', '#2']));
        expect(shown?.cost).toBe(5);
        expect(shown?.time.updated).toBe(9);
    });

    test('keeps a local unlink written without a stream event while the read was in flight', async () => {
        const { directory, store, start } = setup(['#1', '#2']);
        const transport = holdGetSession();

        const done = start();
        await waitForRead(transport);
        store.setState({ session: [record(directory, ['#1'])] });
        transport.resolve(record(directory, ['#1', '#2']));
        await done;

        expect(store.getState().session[0]?.metadata).toEqual(links(['#1']));
    });

    test('leaves an archived session to its archive event, which still removes it', async () => {
        const { directory, store, receive, start } = setup(['#1']);
        const transport = holdGetSession();
        const before = store.getState().session;

        const done = start();
        transport.resolve({ ...record(directory, ['#1']), time: { created: 1, updated: 2, archived: 2 } });
        await done;
        expect(store.getState().session).toBe(before);

        receive({
            type: 'session.patched',
            properties: { sessionID: SESSION_ID, patch: { time: { created: 1, updated: 2, archived: 2 } } },
        });
        expect(store.getState().session).toEqual([]);
        expect(store.getState().sessionTotal).toBe(0);
    });

    test('does not read a session the store holds no record for, such as one still being created', async () => {
        const { store, start } = setup(['#1']);
        store.setState({ session: [], sessionTotal: 0 });
        const transport = holdGetSession();

        await start();

        expect(transport.getSession).not.toHaveBeenCalled();
    });

    test('a failed read leaves the shown record alone', async () => {
        const { store, start } = setup(['#1']);
        const transport = holdGetSession();
        const before = store.getState().session;

        const done = start();
        transport.reject(new Error('not found'));
        await done;

        expect(store.getState().session).toBe(before);
    });
});
