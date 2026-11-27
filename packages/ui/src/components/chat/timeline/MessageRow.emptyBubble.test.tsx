import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { OpenCode, type SessionMessageInfo } from '@opencode/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { projectMessages } from '@/lib/opencode/projection';
import type { Part } from '@/lib/opencode/model';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { SyncContext, SyncRuntimeContext } from '@/sync/sync-runtime-context';
import { attachSyntheticContext } from '../lib/attachSyntheticContext';
import { ChatColumnSessionContext } from '../chatColumnSession';
import { getNormalizedMessageForDisplay } from '../lib/messageDisplayNormalization';
import { createLiveTailStore } from './liveTailStore';
import { MessageRow } from './MessageRow';
import { TimelineRow } from './TimelineRow';
import { TimelineRowContext } from './timelineRowContext';
import type { ChatMessageEntry } from '../lib/turns/types';
import { useTimelineRows } from './useTimelineRows';

const unavailable = (): never => { throw new Error('Unexpected runtime API access'); };
const runtime: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); }, get git() { return unavailable(); },
    files: { listDirectory: unavailable, search: unavailable, createDirectory: unavailable },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};

const sessionID = 'test-timeline';
const time = { created: 1 };

function ReplayTimeline({ messages, grouped }: { messages: ChatMessageEntry[]; grouped: boolean }) {
    const [turnExpansion] = React.useState(() => new Map<string, boolean>());
    const [liveTail] = React.useState(createLiveTailStore);
    const { rows } = useTimelineRows(sessionID, messages, {
        showTurnChangedFiles: false, showReasoningTraces: false, stickyUserHeader: false,
        defaultActivityExpanded: false, keepActivityText: false, turnExpansion,
    });
    if (!grouped) {
        return messages.map((message, index) => (
            <MessageRow key={message.info.id} message={message} nextMessage={messages[index + 1]} isFirstRow={index === 0} />
        ));
    }
    return (
        <TimelineRowContext.Provider value={{
            turnExpansion, liveTail, streamingTailKey: null, sessionIsWorking: false,
            activeStreamingMessageId: null, activeStreamingPhase: null, shouldAnimateUserMessage: () => false,
            onToggleTurnActivity: () => undefined, onUserAnimationConsumed: () => undefined,
        }}>
            {rows.map((row) => <TimelineRow key={row.key} row={row} />)}
        </TimelineRowContext.Provider>
    );
}

async function renderTimeline(messages: SessionMessageInfo[], optimisticParts: Part[] = [], grouped = false) {
    const entries = attachSyntheticContext(projectMessages(messages, sessionID)
        .map(({ message, parts }) => getNormalizedMessageForDisplay({
            info: message, parts: [...parts, ...optimisticParts.filter((part) => part.messageID === message.id)],
        })));
    const dom = new Window({
        url: 'https://timeline.test',
        settings: { fetch: { interceptor: { beforeAsyncRequest: unavailable, beforeSyncRequest: unavailable } } },
    });
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
        Element: dom.Element, Node: dom.Node, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
        getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver,
        MutationObserver: dom.MutationObserver, requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        const sdk = OpenCode.make({ baseUrl: 'https://timeline.test', fetch: unavailable });
        const childStores = new ChildStoreManager();
        const sync = {
            sdk, childStores, runtimeKey: 'test', directory: '/repo',
            currentDirectory: { get: () => '/repo', subscribe: () => () => undefined },
            messageLoader: new SessionMessageLoader(childStores, { sdk: { getSessionMessages: unavailable }, runtimeKey: 'test' }),
        };
        await act(async () => root.render(
            <RuntimeAPIContext.Provider value={runtime}>
                <ThemeSystemProvider>
                    <SyncRuntimeContext.Provider value={sync}>
                        <SyncContext.Provider value={sync}>
                            <I18nProvider>
                                <TooltipProvider>
                                    <ChatColumnSessionContext.Provider value={{ sessionId: sessionID, directory: '/repo' }}>
                                        <ReplayTimeline messages={entries} grouped={grouped} />
                                    </ChatColumnSessionContext.Provider>
                                </TooltipProvider>
                            </I18nProvider>
                        </SyncContext.Provider>
                    </SyncRuntimeContext.Provider>
                </ThemeSystemProvider>
            </RuntimeAPIContext.Provider>
        ));
        const bubbles = Array.from(host.querySelectorAll('[data-user-message-bubble]'));
        return {
            text: host.textContent,
            empty: bubbles.filter((bubble) => !bubble.textContent.trim() && !bubble.querySelector('img, svg'))
                .map((bubble) => bubble.closest('[data-message-id]')?.getAttribute('data-message-id')),
            count: bubbles.length,
        };
    } finally {
        await act(async () => root.unmount());
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    }
}

test('does not draw a user bubble for an empty persisted or optimistic prompt', async () => {
    const result = await renderTimeline([
        { id: 'persisted-empty', type: 'user', text: '', time },
        { id: 'persisted-blank', type: 'user', text: ' \t\n', time },
        { id: 'optimistic-empty', type: 'user', text: '', time },
    ], [
        { id: 'optimistic-text', type: 'text', sessionID, messageID: 'optimistic-empty', text: '' },
    ]);
    expect(result.empty).toEqual([]);
    expect(result.count).toBe(0);
});

test('keeps prompt origins visible even without message text', async () => {
    const result = await renderTimeline([
        { id: 'origin-empty', type: 'user', text: '', time, metadata: { openchamber: { promptedBy: { sessionID: 'parent', title: 'Parent session' } } } },
        { id: 'origin-blank', type: 'user', text: '  ', time, metadata: { openchamber: { promptedBy: { sessionID: 'parent', title: 'Parent session' } } } },
    ]);
    expect(result.empty).toEqual([]);
    expect(result.count).toBe(2);
    expect(result.text).toContain('Parent session');
});

test('keeps standalone rendered context, file chips and notices visible', async () => {
    const result = await renderTimeline([
        {
            id: 'a-context', type: 'synthetic', time, text: 'Model-facing quote',
            metadata: { openchamberContext: { kind: 'chat-quote', quote: 'Quoted reply', text: 'Quote comment' } },
        },
        { id: 'a-prompt', type: 'user', text: '', time },
        {
            id: 'b-context', type: 'synthetic', time, text: 'Model-facing reference',
            metadata: { openchamberContext: { kind: 'guest-issue', providerId: 'example', id: '42', title: 'Guest issue', url: 'https://example.test/42' } },
        },
        { id: 'b-prompt', type: 'user', text: '', time },
        { id: 'c-prompt', type: 'user', text: '', time },
        { id: 'compaction', type: 'compaction', status: 'running', reason: 'manual', summary: '', time },
        {
            id: 'shell', type: 'shell', status: 'exited', shellID: 'shell-1', command: '', exit: 0, time,
            output: { output: '', cursor: 0, size: 0, truncated: false },
        },
        {
            id: 'report', type: 'synthetic', time, text: '<subagent>\n</subagent>', description: 'Finished review',
            metadata: { source: 'subagent', childID: 'child', state: 'completed' },
        },
    ], [
        { id: 'attachment', type: 'file', sessionID, messageID: 'c-prompt', mime: 'application/x-fictional', url: 'data:application/x-fictional;base64,AA==', filename: 'attachment.xyz' },
    ]);
    expect(result.empty).toEqual([]);
    expect(result.count).toBe(3);
    expect(result.text).toContain('Quote comment');
    expect(result.text).toContain('Guest issue');
    expect(result.text).toContain('attachment.xyz');
    expect(result.text).toContain('Compacting the conversation');
    expect(result.text).toContain('Shell');
    expect(result.text).toContain('Finished review');
});
