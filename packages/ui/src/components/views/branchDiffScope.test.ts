import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';

import {
    branchRangeKey,
    coerceDiffScope,
    isBranchScopeAvailable,
    isBranchScopeDefinitelyUnavailable,
    useRangeKeyedCache,
    useBoundedDirectoryRetry,
} from './branchDiffScope';

describe('coerceDiffScope', () => {
    test('keeps the branch scope while it is offered', () => {
        expect(coerceDiffScope('branch', true)).toBe('branch');
    });

    test('falls back to working when the branch scope disappears', () => {
        // Covers a persisted context tab after checking out the default branch
        // or switching to a runtime without the branch scope: the tab must land
        // on a renderable scope instead of a permanent spinner.
        expect(coerceDiffScope('branch', false)).toBe('working');
    });

    test('leaves every other scope untouched regardless of availability', () => {
        for (const scope of ['working', 'staged', 'turn', 'all'] as const) {
            expect(coerceDiffScope(scope, false)).toBe(scope);
            expect(coerceDiffScope(scope, true)).toBe(scope);
        }
    });
});

describe('isBranchScopeAvailable', () => {
    test('available when the default branch is known and different', () => {
        expect(isBranchScopeAvailable('feature-a', 'main')).toBe(true);
    });

    test('unavailable on the default branch itself', () => {
        expect(isBranchScopeAvailable('main', 'main')).toBe(false);
    });

    test('unavailable while the default branch is unknown', () => {
        // Branch metadata loads asynchronously; an unknown default must not
        // flash the Branch option on the guess that the branch differs from it.
        expect(isBranchScopeAvailable('feature-a', null)).toBe(false);
    });

    test('unavailable without a current branch', () => {
        expect(isBranchScopeAvailable(null, 'main')).toBe(false);
        expect(isBranchScopeAvailable(null, null)).toBe(false);
    });
});

describe('isBranchScopeDefinitelyUnavailable', () => {
    test('unknown metadata is not confirmed unavailability', () => {
        // While branch metadata loads the option stays hidden, but this is
        // "unknown", not "confirmed gone" — coercion must not act on it.
        expect(isBranchScopeDefinitelyUnavailable('feature-a', null, true, false)).toBe(false);
        expect(isBranchScopeDefinitelyUnavailable('feature-a', 'main', true, false)).toBe(false);
    });

    test('unresolved status means the branch is unknown, not gone', () => {
        // During the first status load a null currentBranch is "not loaded
        // yet"; coercing on it would discard a persisted branch scope before
        // the answer arrives.
        expect(isBranchScopeDefinitelyUnavailable(null, 'main', false, false)).toBe(false);
        expect(isBranchScopeDefinitelyUnavailable(null, null, false, true)).toBe(false);
    });

    test('detached HEAD after a settled status is confirmed unavailability', () => {
        // Status finished (or failed) without a branch: the Branch scope is
        // impossible, so a persisted branch scope must coerce away instead of
        // spinning on base resolution forever.
        expect(isBranchScopeDefinitelyUnavailable(null, 'main', true, false)).toBe(true);
        expect(isBranchScopeDefinitelyUnavailable(null, null, true, true)).toBe(true);
    });

    test('metadata settled without a default branch is confirmed unavailability', () => {
        // `getBranches` can succeed while git/remote never reported a default
        // branch: retries will not change that, the option stays hidden, and a
        // persisted branch scope must coerce instead of spinning on base
        // resolution forever.
        expect(isBranchScopeDefinitelyUnavailable('feature-a', null, true, true)).toBe(true);
        expect(isBranchScopeAvailable('feature-a', null)).toBe(false);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('feature-a', null, true, true))).toBe('working');
    });

    test('confirmed when the default branch is known and we are on it', () => {
        expect(isBranchScopeDefinitelyUnavailable('main', 'main', true, true)).toBe(true);
        expect(isBranchScopeDefinitelyUnavailable('feature-a', 'main', true, true)).toBe(false);
    });

    test('a persisted branch scope survives loading metadata and is coerced once the answer arrives', () => {
        // The scenario: a context tab persisted scope='branch' and the panel
        // reopens while branch metadata is still loading (null default).
        // First render — option hidden, but NOT coerced away:
        expect(isBranchScopeAvailable('feature-a', null)).toBe(false);
        expect(isBranchScopeDefinitelyUnavailable('feature-a', null, true, false)).toBe(false);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('feature-a', null, true, false))).toBe('branch');

        // Metadata arrives and confirms a feature branch — still available:
        expect(isBranchScopeAvailable('feature-a', 'main')).toBe(true);
        expect(isBranchScopeDefinitelyUnavailable('feature-a', 'main', true, true)).toBe(false);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('feature-a', 'main', true, true))).toBe('branch');

        // User checks out the default branch — now confirmed, coerce:
        expect(isBranchScopeDefinitelyUnavailable('main', 'main', true, true)).toBe(true);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('main', 'main', true, true))).toBe('working');
    });

    test('a persisted branch scope coerces after detached HEAD once status settles', () => {
        // Status still loading with a persisted branch scope — keep it:
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, 'main', false, false))).toBe('branch');
        // Status settles on detached HEAD — coerce:
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, 'main', true, false))).toBe('working');
    });

    test('first render before the status request starts does not read as settled detached HEAD', () => {
        // Sequence of a fresh mount with a persisted branch scope:
        // 1. status===null, loading===false (request has not started yet),
        // 2. loading===true,
        // 3. settled status object with current===null (true detached HEAD).
        // Only step 3 may coerce; steps 1-2 are "unknown" and keep the scope.
        expect(isBranchScopeDefinitelyUnavailable(null, null, false, false)).toBe(false);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, null, false, false))).toBe('branch');
        expect(isBranchScopeDefinitelyUnavailable(null, null, false, true)).toBe(false);
        expect(isBranchScopeDefinitelyUnavailable(null, null, true, false)).toBe(true);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, null, true, false))).toBe('working');
    });
});

describe('branchRangeKey', () => {
    test('distinguishes bases, heads, and directories for the same path', () => {
        // The same file path can carry different diff content per range; a cache
        // keyed by path alone would leak a previous branch's patch.
        const keys = [
            branchRangeKey('/repo', 'main', 'feature-a'),
            branchRangeKey('/repo', 'develop', 'feature-a'),
            branchRangeKey('/repo', 'main', 'feature-b'),
            branchRangeKey('/other', 'main', 'feature-a'),
        ];
        expect(new Set(keys).size).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// useRangeKeyedCache
// ---------------------------------------------------------------------------

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((next, decline) => {
        resolve = next;
        reject = decline;
    });
    return { promise, resolve, reject };
};

const installMinimalDom = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    /** Minimal Document surface createRoot touches in these tests. */
    type DocumentStub = {
        nodeType: 9;
        defaultView: typeof globalThis;
        activeElement: Element | null;
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
        documentElement: typeof container;
        body: typeof container;
    };
    const container = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: null as DocumentStub | null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const documentStub: DocumentStub = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        documentElement: container,
        body: container,
    };
    container.ownerDocument = documentStub;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
    setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    return {
        // SAFETY: the container stub implements the Element surface createRoot
        // touches (nodeType/tagName/listeners); the real Element type is not
        // constructible without a DOM implementation, so the gap goes through
        // unknown deliberately.
        container: container as unknown as Element,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

describe('useRangeKeyedCache', () => {
    test('a stale completion from the previous range cannot write into the new range', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        // One shared path so the same key would be overwritten if the guard
        // was missing.
        const pathsKey = 'src/shared.ts';
        const rangeA = '["/repo","main","feature-a"]';
        const rangeB = '["/repo","develop","feature-b"]';
        const fetchA = deferred<string>();
        const fetchB = deferred<string>();
        type CapturedEntries = { entries: ReadonlyMap<string, string> | null };
        const captured: CapturedEntries = { entries: null };

        let currentFetcher: (path: string) => Promise<string> = () => fetchA.promise;

        const Harness = () => {
            captured.entries = useRangeKeyedCache<string>(
                rangeKey,
                pathsKey,
                currentFetcher,
                'placeholder'
            );
            return null;
        };
        let rangeKey: string = rangeA;

        try {
            await act(async () => root.render(React.createElement(Harness)));
            expect(captured.entries?.get(pathsKey)).toBe('placeholder');

            // Switch the range while A's fetch is still in flight.
            rangeKey = rangeB;
            currentFetcher = () => fetchB.promise;
            await act(async () => root.render(React.createElement(Harness)));
            expect(captured.entries?.get(pathsKey)).toBe('placeholder');

            // B completes first: its value must land.
            await act(async () => {
                fetchB.resolve('diff-from-develop');
                await Promise.resolve();
            });
            expect(captured.entries?.get(pathsKey)).toBe('diff-from-develop');

            // A completes last: the stale result must be discarded, not written
            // over range B's entry.
            await act(async () => {
                fetchA.resolve('diff-from-main');
                await Promise.resolve();
            });
            expect(captured.entries?.get(pathsKey)).toBe('diff-from-develop');
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('a stale rejection from the previous range cannot delete the new range entry', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const pathsKey = 'src/shared.ts';
        const rangeA = '["/repo","main","feature-a"]';
        const rangeB = '["/repo","develop","feature-b"]';
        const fetchA = deferred<string>();
        const fetchB = deferred<string>();
        type CapturedEntries = { entries: ReadonlyMap<string, string> | null };
        const captured: CapturedEntries = { entries: null };

        let currentFetcher: (path: string) => Promise<string> = () => fetchA.promise;
        let rangeKey: string = rangeA;

        const Harness = () => {
            captured.entries = useRangeKeyedCache<string>(rangeKey, pathsKey, currentFetcher, 'placeholder');
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            rangeKey = rangeB;
            currentFetcher = () => fetchB.promise;
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => {
                fetchB.resolve('diff-from-develop');
                await Promise.resolve();
            });
            expect(captured.entries?.get(pathsKey)).toBe('diff-from-develop');

            // The old range's fetch fails after the switch: it must not delete
            // the new range's completed entry.
            await act(async () => {
                fetchA.reject(new Error('stale failure'));
                await Promise.resolve();
            });
            expect(captured.entries?.get(pathsKey)).toBe('diff-from-develop');
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('releases reservations for paths that never completed so a later run retries them', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const pathsKey = 'src/first.ts';
        const stuck = deferred<string>();
        type CapturedEntries = { entries: ReadonlyMap<string, string> | null };
        const captured: CapturedEntries = { entries: null };

        let currentPathsKey = pathsKey;
        const fetched: string[] = [];

        const Harness = () => {
            captured.entries = useRangeKeyedCache<string>(
                'range',
                currentPathsKey,
                (path) => {
                    fetched.push(path);
                    return currentPathsKey === pathsKey ? stuck.promise : Promise.resolve(`resolved-${path}`);
                },
                'placeholder'
            );
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            expect(fetched).toEqual(['src/first.ts']);
            expect(captured.entries?.get('src/first.ts')).toBe('placeholder');

            // Expand a different set of paths; the stuck reservation for
            // src/first.ts is released, and a later run fetches it again.
            currentPathsKey = 'src/first.ts\u0000src/second.ts';
            await act(async () => root.render(React.createElement(Harness)));
            expect(fetched).toEqual(['src/first.ts', 'src/first.ts', 'src/second.ts']);
            expect(captured.entries?.get('src/first.ts')).toBe('resolved-src/first.ts');
            expect(captured.entries?.get('src/second.ts')).toBe('resolved-src/second.ts');
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
});

describe('useBoundedDirectoryRetry', () => {
    test('starts once and reports no exhaustion on success', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const started: string[] = [];
        let hasResult = false;
        let latestExhausted: boolean | null = null;

        const Harness = () => {
            latestExhausted = useBoundedDirectoryRetry(
                '/repo', true, false, hasResult,
                () => { started.push('/repo'); }, 3
            );
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            expect(started).toEqual(['/repo']);
            expect(latestExhausted).toBe(false);

            // Result arrives: no further starts, no exhaustion.
            hasResult = true;
            await act(async () => root.render(React.createElement(Harness)));
            expect(started).toEqual(['/repo']);
            expect(latestExhausted).toBe(false);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('retries bounded times on failure, then reports exhaustion without looping', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const started: string[] = [];
        let inFlight = false;
        let latestExhausted: boolean | null = null;

        const Harness = () => {
            latestExhausted = useBoundedDirectoryRetry(
                '/repo', true, inFlight, false,
                () => { started.push('/repo'); }, 3
            );
            return null;
        };

        try {
            // Each attempt is one in-flight transition: the start flips the
            // caller's flag up, the failed request settles it back down.
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                inFlight = false;
                await act(async () => root.render(React.createElement(Harness)));
                expect(started).toHaveLength(attempt);
                inFlight = true;
                await act(async () => root.render(React.createElement(Harness)));
            }
            expect(latestExhausted).toBe(false);

            // Fourth transition: attempts exhausted, no more starts.
            inFlight = false;
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => root.render(React.createElement(Harness)));
            expect(started).toHaveLength(3);
            expect(latestExhausted).toBe(true);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('exhaustion does not leak into the next directory on the first render', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const started: string[] = [];
        let directory: string = '/repo-a';
        let inFlight = false;
        let hasResult = false;
        let latestExhausted: boolean | null = null;

        const Harness = () => {
            latestExhausted = useBoundedDirectoryRetry(
                directory, true, inFlight, hasResult,
                () => { started.push(directory); }, 2
            );
            return null;
        };

        try {
            // Burn through both retries for /repo-a until exhausted.
            for (let attempt = 1; attempt <= 2; attempt += 1) {
                inFlight = false;
                await act(async () => root.render(React.createElement(Harness)));
                inFlight = true;
                await act(async () => root.render(React.createElement(Harness)));
            }
            inFlight = false;
            await act(async () => root.render(React.createElement(Harness)));
            expect(latestExhausted).toBe(true);

            // Switch to another directory (a new tab with a persisted branch
            // scope): exhaustion must reset in the SAME render, before any
            // effect could rewrite the scope, and retries restart for it.
            directory = '/repo-b';
            await act(async () => root.render(React.createElement(Harness)));
            expect(latestExhausted).toBe(false);
            expect(started).toEqual(['/repo-a', '/repo-a', '/repo-b']);

            hasResult = true;
            await act(async () => root.render(React.createElement(Harness)));
            expect(latestExhausted).toBe(false);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('an in-flight request suppresses duplicate starts from another consumer', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const started: string[] = [];

        const Harness = () => {
            useBoundedDirectoryRetry(
                '/repo', true, true, false,
                () => { started.push('/repo'); }, 3
            );
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => root.render(React.createElement(Harness)));
            expect(started).toEqual([]);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
});
