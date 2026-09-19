import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';

import UserTextPart from './UserTextPart';
import type { Part } from '@opencode-ai/sdk/v2';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';

// Plain rendering keeps the lazy markdown module (and its shiki worker asset
// import) out of the test graph; the expand affordance is mode-independent.
useUIStore.setState({ userMessageRenderingMode: 'plain' });

const sdk = createOpencodeClient({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
});

// bun test shares globalThis across a file; install a happy-dom window for the
// client-only measurement effect, mirroring ReasoningPart.test.tsx.
const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'customElements',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'SVGElement',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'ResizeObserver',
  'MutationObserver',
  'MouseEvent',
  'KeyboardEvent',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const EXPAND_ARIA = 'Expand user message';

type TextPartFixture = Extract<Part, { type: 'text' }>;

const makeTextPart = (text: string): TextPartFixture => ({
    id: 'prt_truncation_3742',
    sessionID: 'ses_3742',
    messageID: 'msg_3742',
    type: 'text',
    text,
});

// A context part: `readContextPart` validates metadata[openchamberContext]
// and routes UserTextPart to the collapsed ContextCard branch.
type ChatQuotePartFixture = Extract<Part, { type: 'text' }>;

const makeChatQuotePart = (): ChatQuotePartFixture => ({
    id: 'prt_context_3742',
    sessionID: 'ses_3742',
    messageID: 'msg_3742',
    type: 'text',
    text: 'Comment on this fragment of an earlier message in this conversation:\n> Quoted line\n\nBecause it settles the question.',
    synthetic: true,
    metadata: {
        [CONTEXT_METADATA_KEY]: {
            kind: 'chat-quote',
            quote: 'Quoted line',
            text: 'Because it settles the question.',
        },
    },
});

// SAFETY: happy-dom types querySelector results as its own class instances;
// the runtime objects satisfy React's expected HTMLElement shape because the
// stub installed exactly these happy-dom classes as the global DOM types.

const installDomStub = () => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map(
        (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    );
    const observers: Array<{ notify(): void }> = [];
    class ResizeObserverStub implements ResizeObserver {
        readonly targets = new Set<Element>();

        constructor(private readonly callback: ResizeObserverCallback) {
            observers.push(this);
        }
        observe(target: Element) { this.targets.add(target); }
        unobserve(target: Element) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
        notify() {
            // SAFETY: this stub implements the full ResizeObserver contract, so
            // the callback receives a valid observer argument.
            if (this.targets.size > 0) this.callback([], this as ResizeObserver);
        }
    }
    const values = {
        window: happyWindow,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        customElements: happyWindow.customElements,
        Node: happyWindow.Node,
        NodeList: happyWindow.NodeList,
        Element: happyWindow.Element,
        HTMLElement: happyWindow.HTMLElement,
        SVGElement: happyWindow.SVGElement,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
        ResizeObserver: ResizeObserverStub,
        MutationObserver: happyWindow.MutationObserver,
        MouseEvent: happyWindow.MouseEvent,
        KeyboardEvent: happyWindow.KeyboardEvent,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const name of DOM_GLOBAL_NAMES) {
        Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }

    const container = document.createElement('div');
    document.body.appendChild(container);

    return {
        container,
        observers,
        restore: () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

// Drives the geometry the truncation effect reads: `scrollHeight` is the
// natural content height and `clientHeight` the clamped box height.
const setClampedGeometry = (el: HTMLElement, clampedHeight: number, contentHeight: number) => {
    Object.defineProperties(el, {
        clientHeight: { configurable: true, value: clampedHeight },
        scrollHeight: { configurable: true, value: contentHeight },
    });
};

describe('UserTextPart expand affordance (issue #3742)', () => {
    test('collapsed truncated message renders the expand button and clicking it expands the message', async () => {
        const dom = installDomStub();
        const onExpandMessage = () => { expandCalls += 1; };
        let expandCalls = 0;
        const part = makeTextPart(`${'Long user report. '.repeat(40)}`);
        const root = createRoot(dom.container);

        try {
            await act(async () => {
                root.render(
                    <SyncProvider sdk={sdk} directory="">
                        <I18nProvider>
                            <UserTextPart
                                part={part}
                                messageId="msg_3742"
                                isMobile={false}
                                messageExpanded={false}
                                onExpandMessage={onExpandMessage}
                            />
                        </I18nProvider>
                    </SyncProvider>,
                );
            });

            // SAFETY: the container is a happy-dom HTMLElement the stub
            // installed as the global DOM class; the selector is this
            // component's clamped text div.
            const textDiv = dom.container.querySelector('div.relative > div') as HTMLElement;
            if (!textDiv) throw new Error('Expected the clamped user text div');
            setClampedGeometry(textDiv, 40, 200);
            await act(async () => {
                dom.observers.forEach((observer) => observer.notify());
            });

            const expandButton = dom.container.querySelector<HTMLButtonElement>(`button[aria-label="${EXPAND_ARIA}"]`);
            expect(expandButton).not.toBeNull();

            await act(async () => {
                expandButton?.click();
            });
            expect(expandCalls).toBe(1);
        } finally {
            await act(async () => {
                root.unmount();
            });
            dom.restore();
        }
    });

    test('short non-truncated collapsed message renders no expand button', async () => {
        const dom = installDomStub();
        const part = makeTextPart('Short message.');
        const root = createRoot(dom.container);

        try {
            await act(async () => {
                root.render(
                    <SyncProvider sdk={sdk} directory="">
                        <I18nProvider>
                            <UserTextPart
                                part={part}
                                messageId="msg_3742"
                                isMobile={false}
                                messageExpanded={false}
                                onExpandMessage={() => undefined}
                            />
                        </I18nProvider>
                    </SyncProvider>,
                );
            });

            // SAFETY: same happy-dom container and selector as the truncated
            // case above; the runtime class satisfies HTMLElement.
            const textDiv = dom.container.querySelector('div.relative > div') as HTMLElement;
            if (!textDiv) throw new Error('Expected the clamped user text div');
            setClampedGeometry(textDiv, 40, 40);
            await act(async () => {
                dom.observers.forEach((observer) => observer.notify());
            });

            expect(dom.container.querySelector(`button[aria-label="${EXPAND_ARIA}"]`)).toBeNull();
        } finally {
            await act(async () => {
                root.unmount();
            });
            dom.restore();
        }
    });

    test('collapsed context card expands on Enter, Space, and click; other keys and Escape do nothing', async () => {
        const dom = installDomStub();
        let expandCalls = 0;
        const onExpandMessage = () => { expandCalls += 1; };
        const part = makeChatQuotePart();
        const root = createRoot(dom.container);

        try {
            await act(async () => {
                root.render(
                    <SyncProvider sdk={sdk} directory="">
                        <I18nProvider>
                            <UserTextPart
                                part={part}
                                messageId="msg_3742"
                                isMobile={false}
                                messageExpanded={false}
                                onExpandMessage={onExpandMessage}
                            />
                        </I18nProvider>
                    </SyncProvider>,
                );
            });

            // SAFETY: the container is a happy-dom HTMLElement the stub
            // installed as the global DOM class; this selector is the
            // collapsed ContextCard row rendered by UserContextPart.
            const card = dom.container.querySelector('[role="button"]') as HTMLElement;
            if (!card) throw new Error('Expected the collapsed context card row');

            const keydown = (key: string) => {
                card.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, cancelable: true }));
            };

            // A document-level listener sits after React's root-container
            // listener in the bubble path, so defaultPrevented here proves
            // the component's key handler called preventDefault.
            const preventedKeys: string[] = [];
            document.addEventListener('keydown', (event) => {
                if (event.defaultPrevented) preventedKeys.push(event.key);
            });

            // Enter and Space each fire exactly one expand.
            await act(async () => { keydown('Enter'); });
            expect(expandCalls).toBe(1);
            await act(async () => { keydown(' '); });
            expect(expandCalls).toBe(2);
            expect(preventedKeys).toEqual(['Enter', ' ']);

            // A non-modifier key and Escape must not expand.
            await act(async () => { keydown('Escape'); });
            await act(async () => { keydown('ArrowDown'); });
            expect(expandCalls).toBe(2);

            // Click expands too.
            await act(async () => { card.click(); });
            expect(expandCalls).toBe(3);
        } finally {
            await act(async () => {
                root.unmount();
            });
            dom.restore();
        }
    });
});