import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
    createHistoryState,
    resetHistoryState,
    stepNewer,
    stepOlder,
    syncHistoryState,
    type HistoryState,
    type MessageHistory,
    type MessageHistoryValue,
    useMessageHistory,
} from '../useMessageHistory';

type Attachment = { id: string };

const draft = (text: string, attachments: readonly Attachment[] = []): MessageHistoryValue<Attachment> => ({
    text,
    attachments,
});

const HISTORY = [
    draft('oldest'),
    draft('middle'),
    draft('newest'),
] as const;

function createState(history: readonly MessageHistoryValue<Attachment>[] = HISTORY, identity = 'session-a') {
    return createHistoryState(history, identity);
}

function older(
    state: HistoryState<Attachment>,
    currentValue: MessageHistoryValue<Attachment>,
    history: readonly MessageHistoryValue<Attachment>[] = HISTORY,
) {
    return stepOlder(state, history, currentValue);
}

function newer(
    state: HistoryState<Attachment>,
    currentValue: MessageHistoryValue<Attachment>,
    history: readonly MessageHistoryValue<Attachment>[] = HISTORY,
) {
    return stepNewer(state, history, currentValue);
}

type MinimalDocument = {
    nodeType: 9;
    defaultView: typeof globalThis;
    activeElement: null;
    addEventListener: () => void;
    removeEventListener: () => void;
    documentElement?: MinimalContainer;
    body?: MinimalContainer;
};

type MinimalContainer = {
    nodeType: 1;
    tagName: 'DIV';
    nodeName: 'DIV';
    namespaceURI: 'http://www.w3.org/1999/xhtml';
    ownerDocument: MinimalDocument;
    addEventListener: () => void;
    removeEventListener: () => void;
};

type MessageHistoryHookResult = {
    current: MessageHistory<Attachment> | null;
};

function installMinimalDom() {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = <T,>(name: string, value: T) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentStub: MinimalDocument = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const container: MinimalContainer = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = container;
    documentStub.body = container;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    return {
        // SAFETY: the hook probe renders `null`; React only needs a stable root-like container shape here.
        container: container as Element & MinimalContainer,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
}

function renderMessageHistory(
    history: readonly MessageHistoryValue<Attachment>[],
    identity: string,
) {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const result: MessageHistoryHookResult = { current: null };

    const Probe: React.FC<{ history: readonly MessageHistoryValue<Attachment>[]; identity: string }> = ({ history, identity }) => {
        result.current = useMessageHistory(history, identity);
        return null;
    };

    const render = (nextHistory: readonly MessageHistoryValue<Attachment>[], nextIdentity: string) => {
        act(() => {
            root.render(React.createElement(Probe, { history: nextHistory, identity: nextIdentity }));
        });
    };

    render(history, identity);

    return {
        current() {
            if (!result.current) throw new Error('message history hook did not render');
            return result.current;
        },
        rerender(nextHistory: readonly MessageHistoryValue<Attachment>[], nextIdentity: string) {
            render(nextHistory, nextIdentity);
        },
        teardown() {
            act(() => {
                root.unmount();
            });
            dom.restore();
        },
    };
}

describe('message history cursor model', () => {
    test('uses a 0..history.length cursor with the draft at the endpoint', () => {
        const state = createState();
        expect(state.cursor).toBe(HISTORY.length);

        const newest = older(state, draft('half-written prompt'));
        expect(newest.value).toEqual(draft('newest'));
        expect(newest.state.cursor).toBe(HISTORY.length - 1);

        const middle = older(newest.state, draft('newest'));
        expect(middle.value).toEqual(draft('middle'));
        expect(middle.state.cursor).toBe(HISTORY.length - 2);

        const oldest = older(middle.state, draft('middle'));
        expect(oldest.value).toEqual(draft('oldest'));
        expect(oldest.state.cursor).toBe(0);
    });

    test('clamps at both ends', () => {
        const state = createState();
        expect(newer(state, draft('draft')).value).toBeNull();

        const first = older(state, draft('draft'));
        const second = older(first.state, draft('newest'));
        const third = older(second.state, draft('middle'));
        const clamped = older(third.state, draft('oldest'));

        expect(clamped.value).toBeNull();
        expect(clamped.state.cursor).toBe(0);
    });

    test('restores an empty draft when the user returns to the endpoint', () => {
        const state = createState();
        const recalled = older(state, draft(''));
        const restored = newer(recalled.state, draft('newest'));

        expect(restored.value).toEqual(draft(''));
        expect(restored.state.cursor).toBe(HISTORY.length);
    });
});

describe('message history overlays', () => {
    test('restores edited text for recalled entries and the original draft', () => {
        const state = createState();

        const recalledNewest = older(state, draft('original draft'));
        const recalledMiddle = older(recalledNewest.state, draft('edited newest'));
        const backToNewest = newer(recalledMiddle.state, draft('middle'));
        const backToDraft = newer(backToNewest.state, draft('edited newest'));

        expect(backToNewest.value).toEqual(draft('edited newest'));
        expect(backToDraft.value).toEqual(draft('original draft'));
    });

    test('restores edited attachments for recalled entries and the draft endpoint', () => {
        const draftAttachment = { id: 'draft-file' };
        const recalledAttachment = { id: 'edited-file' };

        const state = createState();
        const recalledNewest = older(state, draft('draft text', [draftAttachment]));
        const recalledMiddle = older(recalledNewest.state, draft('newest', [recalledAttachment]));
        const backToNewest = newer(recalledMiddle.state, draft('middle'));
        const backToDraft = newer(backToNewest.state, draft('newest', [recalledAttachment]));

        expect(backToNewest.value).toEqual(draft('newest', [recalledAttachment]));
        expect(backToDraft.value).toEqual(draft('draft text', [draftAttachment]));
    });

    test('reset clears overlays and returns to the draft endpoint', () => {
        const state = createState();
        const recalled = older(state, draft('stashed draft'));
        const editedState = older(recalled.state, draft('edited newest')).state;

        const reset = resetHistoryState(editedState, HISTORY);
        expect(reset.cursor).toBe(HISTORY.length);

        const backIntoHistory = older(reset, draft('fresh draft'));
        expect(backIntoHistory.value).toEqual(draft('newest'));

        const backToDraft = newer(backIntoHistory.state, draft('newest'));
        expect(backToDraft.value).toEqual(draft('fresh draft'));
    });
});

describe('message history synchronization', () => {
    test('resets when the active identity changes', () => {
        const state = createState();
        const recalled = older(state, draft('draft')).state;

        const reset = syncHistoryState(recalled, HISTORY, 'session-b');
        expect(reset.cursor).toBe(HISTORY.length);

        const backIntoHistory = older(reset, draft('new identity draft'));
        expect(backIntoHistory.value).toEqual(draft('newest'));

        const restored = newer(backIntoHistory.state, draft('newest'));
        expect(restored.value).toEqual(draft('new identity draft'));
    });

    test('reset after send drops stale overlays before the sent message is appended', () => {
        const state = createState();
        const recalled = older(state, draft('sent draft')).state;
        const reset = resetHistoryState(recalled, HISTORY);
        const appendedHistory = [...HISTORY, draft('sent draft')];
        const synced = syncHistoryState(reset, appendedHistory, 'session-a');

        const recalledSent = older(synced, draft(''), appendedHistory);
        expect(recalledSent.value).toEqual(draft('sent draft'));

        const restored = newer(recalledSent.state, draft('sent draft'), appendedHistory);
        expect(restored.value).toEqual(draft(''));
    });

    test('tracks an external append while the user stays at the endpoint', () => {
        const state = createState();
        const appendedHistory = [...HISTORY, draft('latest from elsewhere')];
        const synced = syncHistoryState(state, appendedHistory, 'session-a');

        const recalled = older(synced, draft('draft at endpoint'), appendedHistory);
        expect(recalled.value).toEqual(draft('latest from elsewhere'));
    });

    test('keeps the same logical entry selected while browsing during an external append', () => {
        const state = createState();
        const browsingNewest = older(state, draft('draft')).state;
        const appendedHistory = [...HISTORY, draft('newest appended')];
        const synced = syncHistoryState(browsingNewest, appendedHistory, 'session-a');

        const newerEntry = newer(synced, draft('newest'), appendedHistory);
        expect(newerEntry.value).toEqual(draft('newest appended'));

        const restored = newer(newerEntry.state, draft('newest appended'), appendedHistory);
        expect(restored.value).toEqual(draft('draft'));
    });

    test('preserves the current logical entry when a 40-entry bucket trims its oldest value', () => {
        const history = Array.from({ length: 40 }, (_, index) => draft(`message-${index}`));
        const state = createState(history);
        const browsingMessage39 = older(state, draft('draft'), history).state;
        const browsingMessage38 = older(browsingMessage39, draft('message-39'), history).state;
        const trimmedAndAppended = [...history.slice(1), draft('message-40')];
        const synced = syncHistoryState(browsingMessage38, trimmedAndAppended, 'session-a');

        expect(synced.cursor).toBe(37);

        const newerEntry = newer(synced, draft('message-38'), trimmedAndAppended);
        expect(newerEntry.value).toEqual(draft('message-39'));
    });
});

describe('useMessageHistory', () => {
    test('round-trips edited recalled entries and the live draft through the generic API', () => {
        const rendered = renderMessageHistory(HISTORY, 'session-a');

        try {
            const draftAttachment = { id: 'draft-file' };
            const recalledAttachment = { id: 'edited-file' };

            let recalledNewest: MessageHistoryValue<Attachment> | null = null;
            let recalledMiddle: MessageHistoryValue<Attachment> | null = null;
            let restoredNewest: MessageHistoryValue<Attachment> | null = null;
            let restoredDraft: MessageHistoryValue<Attachment> | null = null;

            act(() => {
                recalledNewest = rendered.current().older(draft('draft text', [draftAttachment]));
            });
            act(() => {
                recalledMiddle = rendered.current().older(draft('newest', [recalledAttachment]));
            });
            act(() => {
                restoredNewest = rendered.current().newer(draft('middle'));
            });
            act(() => {
                restoredDraft = rendered.current().newer(draft('newest', [recalledAttachment]));
            });

            expect(recalledNewest).toEqual(draft('newest'));
            expect(recalledMiddle).toEqual(draft('middle'));
            expect(restoredNewest).toEqual(draft('newest', [recalledAttachment]));
            expect(restoredDraft).toEqual(draft('draft text', [draftAttachment]));
            expect(rendered.current().isBrowsing).toBe(false);
        } finally {
            rendered.teardown();
        }
    });

    test('reset exits browsing and drops stale overlays', () => {
        const rendered = renderMessageHistory(HISTORY, 'session-a');

        try {
            act(() => {
                rendered.current().older(draft('fresh draft'));
            });
            act(() => {
                rendered.current().older(draft('edited newest'));
            });

            expect(rendered.current().isBrowsing).toBe(true);

            act(() => {
                rendered.current().reset();
            });

            expect(rendered.current().isBrowsing).toBe(false);

            let recalled: MessageHistoryValue<Attachment> | null = null;
            let restoredDraft: MessageHistoryValue<Attachment> | null = null;

            act(() => {
                recalled = rendered.current().older(draft('fresh draft'));
            });
            act(() => {
                restoredDraft = rendered.current().newer(draft('newest'));
            });

            expect(recalled).toEqual(draft('newest'));
            expect(restoredDraft).toEqual(draft('fresh draft'));
        } finally {
            rendered.teardown();
        }
    });

    test('resets browsing when the identity changes', () => {
        const rendered = renderMessageHistory(HISTORY, 'session-a');

        try {
            act(() => {
                rendered.current().older(draft('new identity draft'));
            });

            expect(rendered.current().isBrowsing).toBe(true);

            rendered.rerender(HISTORY, 'session-b');

            expect(rendered.current().isBrowsing).toBe(false);

            let recalled: MessageHistoryValue<Attachment> | null = null;
            let restoredDraft: MessageHistoryValue<Attachment> | null = null;

            act(() => {
                recalled = rendered.current().older(draft('new identity draft'));
            });
            act(() => {
                restoredDraft = rendered.current().newer(draft('newest'));
            });

            expect(recalled).toEqual(draft('newest'));
            expect(restoredDraft).toEqual(draft('new identity draft'));
        } finally {
            rendered.teardown();
        }
    });
});
