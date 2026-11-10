import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { FormRequest } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://form.test' });
Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    localStorage: browser.localStorage,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { OpenCode } = await import('@opencode/client');
const { Toaster, toast } = await import('sonner');
const { I18nProvider } = await import('@/lib/i18n');
const { SyncProvider } = await import('@/sync/sync-context');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { ChatColumnSessionContext } = await import('./chatColumnSession');
const { FormDock } = await import('./FormDock');
const { FormCard } = await import('./FormCard');

const directory = '/test/forms';
const sessionID = 'session-form';
const message = 'Fixture form submission failed.';
const form: FormRequest = {
    id: 'form-answer', sessionID, title: 'A pending question',
    fields: [{ key: 'answer', type: 'boolean', title: 'Answer' }],
};
const searchForm: FormRequest = {
    id: 'form-search', sessionID, title: 'Web search', metadata: { kind: 'websearch.provider' },
    fields: [{ key: 'choice', type: 'string', options: [{ label: 'Allow', value: 'allow' }], required: true }],
};
// Bootstrap must stay pending so it cannot replace the fixture request.
const sdk = OpenCode.make({ baseUrl: 'http://form.test', fetch: () => new Promise<Response>(() => {}) });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
let reply: ReturnType<typeof spyOn<typeof opencodeClient, 'replyToForm'>>;

beforeEach(async () => {
    reply = spyOn(opencodeClient, 'replyToForm').mockRejectedValue(new Error(message));
    await browser.navigator.clipboard.writeText('');
    useConfigStore.setState({ isConnected: true, hasEverConnected: true, connectionPhase: 'connected' });
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    toast.dismiss();
    reply.mockRestore();
    root = createRoot(container);
});

afterAll(async () => {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    await browser.happyDOM.close();
});

const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

describe('form submission error details', () => {
    for (const surface of ['dock', 'card', 'web search'] as const) {
        test(`${surface} shows and copies the submission error`, async () => {
            const pending = surface === 'web search' ? searchForm : form;
            const submitLabel = surface === 'web search' ? 'Allow' : 'Submit';
            await act(async () => root.render(
                <SyncProvider sdk={sdk} directory={directory}>
                    <I18nProvider>
                        <ChatColumnSessionContext.Provider value={{ sessionId: sessionID, directory }}>
                            {surface === 'card'
                                ? <FormCard form={pending} />
                                : <FormDock sessionId={sessionID} directory={directory} hidden={false} />}
                            <Toaster duration={Infinity} />
                        </ChatColumnSessionContext.Provider>
                    </I18nProvider>
                </SyncProvider>,
            ));
            const store = getSyncChildStores().getChild(directory);
            if (!store) throw new Error('Directory store missing');
            await act(async () => store.setState({ form: { [sessionID]: [pending] } }));
            await click(submitLabel);

            expect(container.querySelector('[data-sonner-toast]')?.textContent).toContain(message);
            await click('Copy');
            expect(await browser.navigator.clipboard.readText()).toBe(message);
        });
    }
});
