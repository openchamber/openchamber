import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@/lib/opencode/model';
import { buildShareUiDocument } from '@/share-document/page';
import { buildShareHtmlDocument } from './shareDocument';

/**
 * What the relay's viewer gets: a document that needs nothing from the
 * network, and whose `openchamber.submit` speaks the viewer's frame protocol
 * (apps/relay/src/share/viewer.ts in the website repository).
 */

const PAGE = '<!doctype html><html><head><title>Pick</title></head><body><button class="oc-button" id="go">Send</button></body></html>';

// Any address outside the document: a URL with a scheme the viewer's policy
// would refuse, or one it would resolve against nothing (`//host`).
const EXTERNAL = /\b(?:https?|wss?|ftp):\/\/|url\(\s*['"]?\/\/|(?:src|href)\s*=\s*['"]?\/\//i;

type ShareApi = { answer: JsonValue; submit: (data: JsonValue | undefined, summary: string) => Promise<void> };

/** The page's globals the script reads, as plain objects the test owns; the script sets `openchamber` on its window. */
type PageWindow = {
    parent: { postMessage: (message: JsonValue, targetOrigin: string) => void };
    addEventListener: EventTarget['addEventListener'];
    openchamber?: ShareApi;
};

const mountShareHtml = (html = PAGE, activation = true, savedAnswer?: string) => {
    const sent: JsonValue[] = [];
    const events = new EventTarget();
    const page: PageWindow = {
        parent: { postMessage: (message) => { sent.push(message); } },
        addEventListener: events.addEventListener.bind(events),
    };
    const source = buildShareHtmlDocument(html);
    const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join(';');
    const globals = {
        window: page,
        // The recipient's app puts a sent answer in this element ahead of the bootstrap.
        document: Object.assign(new EventTarget(), {
            getElementById: (id: string) => (id === 'oc-share-answer' && savedAnswer !== undefined ? { textContent: savedAnswer } : null),
        }),
        navigator: { userActivation: { isActive: activation } },
    };
    new Function(...Object.keys(globals), script)(...Object.values(globals));
    const openchamber = page.openchamber;
    if (!openchamber) throw new Error('the script set no openchamber');
    // A message from the viewer: what the browser would dispatch, its source the page's parent.
    const fromViewer = (data: JsonValue) => events.dispatchEvent(Object.assign(new Event('message'), { data, source: page.parent }));
    return { source, sent, fromViewer, openchamber };
};

const settled = (promise: Promise<void>) => promise.then(() => 'resolved', (error: Error) => `rejected: ${error.message}`);

describe('a shared html page', () => {
    test('carries both default themes and its ready classes, and reaches for nothing outside itself', () => {
        const { source } = mountShareHtml();
        expect(source).toContain('@media (prefers-color-scheme:dark)');
        expect(source).toContain('color-scheme:light dark');
        expect(source).toContain('.oc-button{');
        expect(EXTERNAL.test(source)).toBe(false);
        // The page's own head and body stay as written, after the bootstrap.
        expect(source.indexOf('<style>')).toBeLessThan(source.indexOf('<title>Pick</title>'));
        expect(source).toContain('<button class="oc-button" id="go">Send</button>');
    });

    test('sends its answer to the viewer and settles on the viewer\'s reply', async () => {
        const { sent, fromViewer, openchamber } = mountShareHtml();
        expect(openchamber.answer).toBeNull();
        fromViewer({ source: 'openchamber-share-viewer', type: 'init', wantsAnswer: true, locale: 'uk' });
        const answer = settled(openchamber.submit({ pick: 'b' }, ' Layout B '));
        expect(sent).toEqual([{ source: 'openchamber-share-document', type: 'submit', data: { pick: 'b' }, summary: 'Layout B' }]);
        // A second answer while the first is on its way is refused at once.
        expect(await settled(openchamber.submit({ pick: 'a' }, 'Layout A'))).toBe('rejected: An answer is already on its way');
        fromViewer({ source: 'openchamber-share-viewer', type: 'submit-result', ok: true });
        expect(await answer).toBe('resolved');
        expect(await settled(openchamber.submit({ pick: 'a' }, 'Layout A'))).toBe('rejected: The answer was already sent');
        expect(sent).toHaveLength(1);
    });

    test('rejects with the viewer\'s reason, and can send again after a failure', async () => {
        const { sent, fromViewer, openchamber } = mountShareHtml();
        const first = settled(openchamber.submit(null, 'Yes'));
        fromViewer({ source: 'openchamber-share-viewer', type: 'submit-result', ok: false, error: 'Network error' });
        expect(await first).toBe('rejected: Network error');
        const second = settled(openchamber.submit(null, 'Yes'));
        fromViewer({ source: 'openchamber-share-viewer', type: 'submit-result', ok: true });
        expect(await second).toBe('resolved');
        expect(sent).toHaveLength(2);
    });

    test('refuses what the viewer would: no answer wanted, no click, no summary', async () => {
        const quiet = mountShareHtml();
        quiet.fromViewer({ source: 'openchamber-share-viewer', type: 'init', wantsAnswer: false, locale: 'en' });
        expect(await settled(quiet.openchamber.submit({}, 'Done'))).toBe('rejected: This page does not take an answer');
        expect(await settled(mountShareHtml(PAGE, false).openchamber.submit({}, 'Done'))).toBe('rejected: openchamber.submit works only from a click');
        expect(await settled(mountShareHtml().openchamber.submit({}, ' '))).toBe('rejected: summary is required: the choice in a few words');
        // Messages from anyone but the viewer, or without its source, change nothing.
        const page = mountShareHtml();
        const answer = settled(page.openchamber.submit({}, 'Done'));
        page.fromViewer({ type: 'submit-result', ok: true });
        page.fromViewer({ source: 'someone-else', type: 'submit-result', ok: true });
        page.fromViewer({ source: 'openchamber-share-viewer', type: 'submit-result', ok: false, error: 'Expired' });
        expect(await answer).toBe('rejected: Expired');
    });
});

describe('a shared html page shown again with its answer', () => {
    test('reads the answer before its own scripts run and takes no other', async () => {
        const { openchamber, sent } = mountShareHtml(PAGE, true, '{"pick":"b"}');
        expect(openchamber.answer).toEqual({ pick: 'b' });
        expect(await settled(openchamber.submit({ pick: 'a' }, 'Layout A'))).toBe('rejected: The answer was already sent');
        expect(sent).toEqual([]);
    });
});

describe('a shared ui page', () => {
    test('carries the program and the renderer inline, and nothing that ends its script early', () => {
        const bundle = 'var a="</script><script>alert(1)</script>",b="<!--";console.log(a,b);';
        const source = buildShareUiDocument({ ui: 'root = Stack([Text("a </script> b")])', title: 'A <b> & "c"', expectAnswer: true, bundle });
        expect(EXTERNAL.test(source)).toBe(false);
        expect(source).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>');
        // One script element for the program and one for the renderer, each closed only by its own end tag.
        expect(source.match(/<\/script>/gi)).toHaveLength(2);
        expect(source).not.toContain('<!--');
        const program = /<script type="application\/json" id="oc-share-page">([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '';
        expect(JSON.parse(program)).toEqual({ ui: 'root = Stack([Text("a </script> b")])', title: 'A <b> & "c"', expectAnswer: true });
        // The escaped renderer still means the same code.
        const renderer = /<body><div id="oc-share-root"><\/div><script>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '';
        const logged: string[] = [];
        new Function('console', renderer)({ log: (...values: string[]) => logged.push(...values) });
        expect(logged).toEqual(['</script><script>alert(1)</script>', '<!--']);
    });
});
