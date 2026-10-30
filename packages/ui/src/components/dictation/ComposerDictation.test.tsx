import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UseDictationOptions, DictationStatus } from '@/hooks/useDictation';

const settings = { dictationEnabled: true, dictationAutoSend: true };
const starts: number[] = [];
const completions: Array<() => void> = [];
let nextEngine = 0;

mock.module('@/hooks/useDictation', () => ({
    useDictation: (options: UseDictationOptions) => {
        const [id] = React.useState(() => nextEngine++);
        const [status, setStatus] = React.useState<DictationStatus>('idle');
        return {
            status, partialTranscript: '', duration: 0, error: null, errorReason: null,
            subscribeLevel: () => () => {},
            startDictation: async () => { starts.push(id); setStatus('recording'); },
            confirmDictation: async () => {
                setStatus('uploading');
                completions.push(() => { setStatus('idle'); options.onTranscript?.('transcript'); });
                return null;
            },
            cancelDictation: async () => { setStatus('idle'); },
            retryFailedDictation: async () => null,
            acceptPartialTranscript: () => null,
            discardFailedDictation: () => {},
        };
    },
}));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: typeof settings) => unknown) => select(settings) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { shortcutOverrides: object }) => unknown) => select({ shortcutOverrides: {} }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { colors: { surface: {}, status: {} } } }) }));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => Response.json({}) }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/dictation/use-dictation-audio-source', () => ({ isDictationCaptureSupported: () => true }));
mock.module('@/hooks/useDurationTicker', () => ({ useWaitingBlink: () => '' }));
mock.module('@/components/dictation/DictationWaveform', () => ({ DictationWaveform: () => null }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/lib/shortcuts', () => ({ formatShortcutForDisplay: () => '', getEffectiveShortcutCombo: () => '' }));
mock.module('@/components/ui/action-toolbar', () => ({ TooltipLabelWithShortcut: () => null }));
const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
mock.module('@/components/ui/tooltip', () => ({ Tooltip: Passthrough, TooltipTrigger: Passthrough, TooltipContent: () => null }));

const { ComposerDictation } = await import('./ComposerDictation');
let root: Root;
let dom: Window;
const messages: Array<{ session: string; text: string }> = [];
const insertions: Array<{ session: string; text: string }> = [];

const Composer = ({ session }: { session: string }) => (
    <section data-chat-column={session}>
        <form id={session}>
            <div data-chat-input="true"><div className="cm-content" tabIndex={0} /></div>
            <ComposerDictation
                isMobile={false}
                footerIconButtonClass="" footerPaddingClass="" iconSizeClass="" sendIconSizeClass=""
                onInsert={(text) => insertions.push({ session, text })}
                onInsertAndSend={(text) => messages.push({ session, text: `${session} draft ${text}` })}
            />
        </form>
    </section>
);

beforeEach(async () => {
    dom = new Window();
    Object.assign(globalThis, {
        window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
        CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
    });
    starts.length = 0;
    completions.length = 0;
    messages.length = 0;
    insertions.length = 0;
    nextEngine = 0;
    settings.dictationAutoSend = true;
    settings.dictationEnabled = true;
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<><Composer session="main" /><Composer session="pinned" /></>));
});

afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
});

const focus = (session: string) => document.querySelector<HTMLElement>(`#${session} .cm-content`)!.focus();
const toggle = async (composer?: HTMLFormElement) => {
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle', { detail: { composer } })));
};
const finish = async () => {
    expect(completions).toHaveLength(1);
    await act(async () => completions[0]());
};

for (const session of ['main', 'pinned']) {
    test(`shortcut sends exactly once to the selected ${session} composer`, async () => {
        focus(session);
        await toggle();
        expect(starts).toEqual([session === 'main' ? 0 : 1]);
        // Confirmation stays with the recording even if another composer takes focus.
        focus(session === 'main' ? 'pinned' : 'main');
        await toggle();
        await finish();
        expect(messages).toEqual([{ session, text: `${session} draft transcript` }]);
    });
}

test('Enter confirms only the recording owner and does not submit the other form', async () => {
    focus('pinned');
    await toggle();
    focus('main');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => document.activeElement!.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    await finish();
    expect(messages).toEqual([{ session: 'pinned', text: 'pinned draft transcript' }]);
});

test('mobile trigger addresses its own composer despite focus elsewhere', async () => {
    focus('main');
    await toggle(document.querySelector<HTMLFormElement>('#pinned')!);
    expect(starts).toEqual([1]);
    await toggle();
    await finish();
    expect(messages).toEqual([{ session: 'pinned', text: 'pinned draft transcript' }]);
});

test('without composer focus the shortcut starts only the main composer', async () => {
    await toggle();
    expect(starts).toEqual([0]);
});

test('a collapsed mobile composer can start without a mounted editor', async () => {
    document.querySelectorAll('[data-chat-input]').forEach((editor) => editor.remove());
    await toggle();
    expect(starts).toEqual([0]);
});

test('a mic in another composer cannot start or confirm the owned recording', async () => {
    focus('pinned');
    await toggle();
    await toggle(document.querySelector<HTMLFormElement>('#main')!);
    await act(async () => document.querySelector<HTMLButtonElement>('#main button')!.click());
    expect(starts).toEqual([1]);
    expect(completions).toHaveLength(0);
    await toggle();
    await toggle();
    await finish();
    expect(messages).toEqual([{ session: 'pinned', text: 'pinned draft transcript' }]);
});

test('cancel releases ownership so the next shortcut can record in the other composer', async () => {
    focus('pinned');
    await toggle();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    focus('main');
    await toggle();
    expect(starts).toEqual([1, 0]);
    expect(messages).toEqual([]);
});

test('auto-send disabled inserts only in the selected composer', async () => {
    settings.dictationAutoSend = false;
    await act(async () => root.render(<><Composer session="main" /><Composer session="pinned" /></>));
    focus('pinned');
    await toggle();
    await toggle();
    await finish();
    expect(messages).toEqual([]);
    expect(insertions).toEqual([{ session: 'pinned', text: 'transcript' }]);
});
