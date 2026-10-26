import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';

import {
    coerceDiffScope,
    isBranchScopeAvailable,
    isBranchScopeDefinitelyUnavailable,
    useRangeKeyedCache,
    branchPathRevisions,
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
    test('available on a branch with a base', () => {
        expect(isBranchScopeAvailable('feature-a', 'origin/main')).toBe(true);
    });

    test('available in a repository without a remote once a local base resolves', () => {
        expect(isBranchScopeAvailable('feature-a', 'refs/heads/main')).toBe(true);
    });

    test('unavailable while the branch has no base', () => {
        // Covers both "still resolving" (the option must not flash on a guess)
        // and the default branch, whose resolution skips the branch itself.
        expect(isBranchScopeAvailable('feature-a', null)).toBe(false);
        expect(isBranchScopeAvailable('main', null)).toBe(false);
    });

    test('unavailable without a current branch', () => {
        expect(isBranchScopeAvailable(null, 'origin/main')).toBe(false);
        expect(isBranchScopeAvailable(null, null)).toBe(false);
    });
});

describe('isBranchScopeDefinitelyUnavailable', () => {
    test('a base still resolving is not confirmed unavailability', () => {
        // While the base resolves the option stays hidden, but this is
        // "unknown", not "confirmed gone": coercion must not act on it.
        expect(isBranchScopeDefinitelyUnavailable('feature-a', null, true, false)).toBe(false);
    });

    test('unresolved status means the branch is unknown, not gone', () => {
        // During the first status load a null currentBranch is "not loaded
        // yet"; coercing on it would discard a persisted branch scope before
        // the answer arrives.
        expect(isBranchScopeDefinitelyUnavailable(null, 'origin/main', false, true)).toBe(false);
        expect(isBranchScopeDefinitelyUnavailable(null, null, false, false)).toBe(false);
    });

    test('detached HEAD after a settled status is confirmed unavailability', () => {
        expect(isBranchScopeDefinitelyUnavailable(null, null, true, false)).toBe(true);
        expect(isBranchScopeDefinitelyUnavailable(null, 'origin/main', true, true)).toBe(true);
    });

    test('a resolved base of none is confirmed unavailability', () => {
        // Every candidate answered and none names a base (the default branch,
        // or nothing to compare against): a persisted branch scope must coerce
        // instead of spinning on base resolution forever.
        expect(isBranchScopeDefinitelyUnavailable('main', null, true, true)).toBe(true);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('main', null, true, true))).toBe('working');
    });

    test('a resolved base keeps the scope', () => {
        expect(isBranchScopeDefinitelyUnavailable('feature-a', 'origin/main', true, true)).toBe(false);
        expect(isBranchScopeDefinitelyUnavailable('feature-a', 'refs/heads/main', true, true)).toBe(false);
    });

    test('a persisted branch scope survives a resolving base and is coerced once the answer is none', () => {
        // A context tab persisted scope='branch' and the panel reopens while
        // the base is still resolving. First render: hidden, NOT coerced away.
        expect(isBranchScopeAvailable('feature-a', null)).toBe(false);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('feature-a', null, true, false))).toBe('branch');

        // The base arrives: still available.
        expect(isBranchScopeAvailable('feature-a', 'origin/main')).toBe(true);
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('feature-a', 'origin/main', true, true))).toBe('branch');

        // The person checks out the default branch, which has no base: coerce.
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable('main', null, true, true))).toBe('working');
    });

    test('first render before the status request starts does not read as settled detached HEAD', () => {
        // Sequence of a fresh mount with a persisted branch scope:
        // 1. status===null, loading===false (request has not started yet),
        // 2. loading===true,
        // 3. settled status object with current===null (true detached HEAD).
        // Only step 3 may coerce; steps 1-2 are "unknown" and keep the scope.
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, null, false, false))).toBe('branch');
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, null, false, true))).toBe('branch');
        expect(coerceDiffScope('branch', !isBranchScopeDefinitelyUnavailable(null, null, true, false))).toBe('working');
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
    test('hands the same empty map to every render before a new range loads', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        const seen: Array<ReadonlyMap<string, string>> = [];
        const Harness = () => {
            const entries = useRangeKeyedCache('range', 'a.ts', () => new Promise<string>(() => {}), 'loading');
            seen.push(entries);
            // A render-phase update re-renders before any effect runs, as the
            // find bar's index sync does; a fresh map here looped forever.
            const [pass, setPass] = React.useState(0);
            if (pass < 2) setPass(pass + 1);
            return null;
        };
        try {
            await act(async () => root.render(React.createElement(Harness)));
            expect(seen.length).toBeGreaterThanOrEqual(3);
            expect(seen[1]).toBe(seen[0]);
            expect(seen[2]).toBe(seen[0]);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('refreshes visible paths on revision changes without blanking completed diffs or refetching on rerender', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        let revision = '1';
        let paths = 'a.ts';
        const requests: Array<{ path: string; result: ReturnType<typeof deferred<string>> }> = [];
        type CapturedEntries = { entries: ReadonlyMap<string, string> | null };
        const captured: CapturedEntries = { entries: null };
        const Harness = () => {
            captured.entries = useRangeKeyedCache('range', paths, (path) => {
                const result = deferred<string>();
                requests.push({ path, result });
                return result.promise;
            }, 'loading', revision);
            return null;
        };
        try {
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => requests[0].result.resolve('old'));
            await act(async () => root.render(React.createElement(Harness)));
            expect(requests).toHaveLength(1);
            revision = '2';
            await act(async () => root.render(React.createElement(Harness)));
            expect(requests).toHaveLength(2);
            expect(captured.entries?.get('a.ts')).toBe('old');
            // Changing visible paths cancels the stale refresh and must retry it.
            paths = 'a.ts\0b.ts';
            await act(async () => root.render(React.createElement(Harness)));
            expect(requests.map(({ path }) => path)).toEqual(['a.ts', 'a.ts', 'a.ts', 'b.ts']);
            await act(async () => {
                requests[2].result.resolve('current');
                requests[3].result.resolve('new file');
                requests[1].result.resolve('stale');
            });
            expect(captured.entries?.get('a.ts')).toBe('current');
            expect(captured.entries?.get('b.ts')).toBe('new file');
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('refreshes only the paths whose own revision moved, and nothing on a same-revision listing', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        let revisions: ReadonlyMap<string, string> = branchPathRevisions([
            { path: 'a.ts', revision: 'base:1' },
            { path: 'b.ts', revision: 'base:1' },
            { path: 'c.ts' },
        ], 'status-1');
        const requests: string[] = [];
        const Harness = () => {
            useRangeKeyedCache('range', 'a.ts\0b.ts\0c.ts', async (path) => {
                requests.push(path);
                return path;
            }, 'loading', '', revisions);
            return null;
        };
        try {
            await act(async () => root.render(React.createElement(Harness)));
            expect(requests.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
            requests.length = 0;

            // A status read that changed nothing: a new listing, same revisions.
            revisions = branchPathRevisions([
                { path: 'a.ts', revision: 'base:1' },
                { path: 'b.ts', revision: 'base:1' },
                { path: 'c.ts' },
            ], 'status-1');
            await act(async () => root.render(React.createElement(Harness)));
            expect(requests).toEqual([]);

            // One file written; the file without a server revision follows the status.
            revisions = branchPathRevisions([
                { path: 'a.ts', revision: 'base:2' },
                { path: 'b.ts', revision: 'base:1' },
                { path: 'c.ts' },
            ], 'status-2');
            await act(async () => root.render(React.createElement(Harness)));
            expect(requests.sort()).toEqual(['a.ts', 'c.ts']);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

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

describe('range cache visibility', () => {
    test('pausing requested paths retains completed diffs and defers revision refresh until resume', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        const pending = deferred<string>();
        const fetched: string[] = [];
        let visible = true;
        let revision = 'one';
        const captured: { entries: ReadonlyMap<string, string> | null } = { entries: null };
        const Harness = () => {
            captured.entries = useRangeKeyedCache('range', visible ? 'a\0b' : '', async path => {
                fetched.push(`${revision}:${path}`);
                return path === 'b' && revision === 'one' ? pending.promise : `${revision}:${path}`;
            }, 'loading', revision);
            return null;
        };
        try {
            await act(async () => root.render(React.createElement(Harness)));
            expect(captured.entries?.get('a')).toBe('one:a');
            visible = false;
            revision = 'two';
            await act(async () => root.render(React.createElement(Harness)));
            await act(async () => pending.resolve('stale:b'));
            expect(fetched).toEqual(['one:a', 'one:b']);
            expect(captured.entries?.get('a')).toBe('one:a');
            expect(captured.entries?.has('b')).toBe(false);
            visible = true;
            await act(async () => root.render(React.createElement(Harness)));
            expect(fetched).toEqual(['one:a', 'one:b', 'two:a', 'two:b']);
            expect(captured.entries?.get('a')).toBe('two:a');
            expect(captured.entries?.get('b')).toBe('two:b');
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
