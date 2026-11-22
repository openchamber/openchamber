import React, { act } from 'react';
import { Window } from 'happy-dom';
import { afterAll, afterEach, expect, test } from 'bun:test';

import { useInputStore } from '@/sync/input-store';

import { usePendingComposerText } from '../usePendingComposerText';
import { createComposerText } from '../composerText';

const browser = new Window({ url: 'http://localhost' });
const values = { window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const originalInput = useInputStore.getState();

/** The composer's text the way ChatInput holds it: outside state, with a render per write. */
function useProbeText(initial: string) {
    const [text] = React.useState(() => createComposerText(initial));
    const [, setRevision] = React.useState(0);
    const setMessage = React.useCallback((next: string) => {
        text.set(next);
        setRevision((revision) => revision + 1);
    }, [text]);
    return { text, setMessage };
}

type Props = { hold: boolean; onSlashCommand: () => void; draft: { value: string } };
const Composer: React.FC<Props> = ({ hold, onSlashCommand, draft }) => {
    const { text, setMessage } = useProbeText('DEMO-2');
    draft.value = text.get();
    usePendingComposerText({ target: null, text, setMessage, focus: () => {}, holdSlashCommand: hold, onSlashCommand });
    return null;
};

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    useInputStore.setState(originalInput, true);
});
afterAll(async () => {
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test('a slash command waits while the composer holds it, then starts the draft and leaves shell mode', async () => {
    const draft = { value: '' };
    let slashCommands = 0;
    const onSlashCommand = () => { slashCommands += 1; };
    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Composer hold onSlashCommand={onSlashCommand} draft={draft} />));

    await act(async () => useInputStore.getState().setPendingInputText('task', 'slash-command'));
    expect(draft.value).toBe('DEMO-2');
    expect(useInputStore.getState().pendingInputText).toBe('task');
    expect(slashCommands).toBe(0);

    await act(async () => root?.render(<Composer hold={false} onSlashCommand={onSlashCommand} draft={draft} />));
    expect(draft.value).toBe('/task DEMO-2');
    expect(useInputStore.getState().pendingInputText).toBeNull();
    expect(slashCommands).toBe(1);
});

test('other pending text is not held', async () => {
    const draft = { value: '' };
    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Composer hold onSlashCommand={() => {}} draft={draft} />));
    await act(async () => useInputStore.getState().setPendingInputText('quoted', 'append-inline'));
    expect(draft.value).toBe('DEMO-2 quoted ');
});
