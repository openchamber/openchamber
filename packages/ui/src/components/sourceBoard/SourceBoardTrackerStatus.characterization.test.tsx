// Characterisation: the board's status menu lists a Linear team's workflow
// states in Linear's own order (category, then position, then name), whatever
// order they arrive in; states of no known category come last. The tracker
// refactor kept this order (it was by Linear's state type before).
import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { RuntimeAPIs, TrackerItemSummary, TrackerWorkflowState } from '@/lib/api/types';

const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

// Arrives shuffled; the order is triage, backlog, todo, in progress, done, canceled.
const arriving: TrackerWorkflowState[] = [
    { id: 's-canceled', name: 'Canceled', category: 'canceled', position: 0 },
    { id: 's-review', name: 'In Review', category: 'in-progress', position: 2 },
    { id: 's-done', name: 'Done', category: 'done', position: 0 },
    { id: 's-other', name: 'Custom', category: null, position: 0 },
    { id: 's-progress', name: 'In Progress', category: 'in-progress', position: 1 },
    { id: 's-todo', name: 'Todo', category: 'todo', position: 0 },
    { id: 's-backlog', name: 'Backlog', category: 'backlog', position: 0 },
    { id: 's-triage', name: 'Triage', category: 'triage', position: 0 },
    { id: 's-beta', name: 'Beta', category: 'in-progress', position: 1 },
];

// The runtime through its context, not a module mock: a mocked module stays
// mocked for every test file that runs after this one in the same process.
const { createWebAPIs } = await import('../../../../web/src/api/index');
const base = createWebAPIs();
if (!base.trackers) throw new Error('The web runtime serves trackers');
const apis: RuntimeAPIs = {
    ...base,
    trackers: { ...base.trackers, states: async () => ({ connected: true, states: arriving }) },
};

const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
const actualDropdownMenu = await import('@/components/ui/dropdown-menu');
mock.module('@/components/ui/dropdown-menu', () => ({
    ...actualDropdownMenu,
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <div data-state-id={value}>{children}</div>,
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, success: () => undefined } }));
mock.module('@/components/references/ReferencePreview', () => ({
    StatePill: ({ label }: { label: string }) => <span>{label}</span>,
}));

const { SourceBoardTrackerStatus } = await import('./SourceBoardTrackerStatus');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { useTrackerRegistry } = await import('@/lib/trackers/registry');
const { linearLikeTrackerDescriptor } = await import('@/lib/trackers/descriptor.fixture');

const linear = linearLikeTrackerDescriptor();
useTrackerRegistry.setState({ ordered: [linear], byId: new Map([[linear.id, linear]]), status: 'ready', holdsList: true });

const issue: TrackerItemSummary = {
    provider: 'linear',
    id: 'uuid-1',
    identifier: 'ENG-12',
    title: 'Broken login',
    url: 'https://linear.app/openchamber/issue/ENG-12',
    state: { id: 's-progress', name: 'In Progress', category: 'in-progress' },
    container: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
};

describe('SourceBoardTrackerStatus menu order', () => {
    test('orders a Linear team\'s states by category, then position, then name; unknown categories last', async () => {
        const happyWindow = new Window({ url: 'http://localhost' });
        const names = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
        const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        const values = {
            window: happyWindow,
            document: happyWindow.document,
            Node: happyWindow.Node,
            Element: happyWindow.Element,
            HTMLElement: happyWindow.HTMLElement,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}><SourceBoardTrackerStatus item={issue} onChanged={() => undefined} /></RuntimeAPIContext.Provider></I18nProvider>));
            await act(async () => { await Promise.resolve(); });
            const order = [...container.querySelectorAll('[data-state-id]')].map((node) => node.getAttribute('data-state-id'));
            expect(order).toEqual(['s-triage', 's-backlog', 's-todo', 's-beta', 's-progress', 's-review', 's-done', 's-canceled', 's-other']);
        } finally {
            await act(async () => root.unmount());
            happyWindow.close();
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    });
});
