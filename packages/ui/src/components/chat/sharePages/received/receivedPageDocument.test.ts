import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { JsonValue } from '@/lib/opencode/model';

import { buildReceivedPageShell, lockDownReceivedDocument } from './receivedPageDocument';

describe('a received page prepared for the app', () => {
  const dom = new Window();
  const saved = globalThis.DOMParser;
  beforeAll(() => { Object.assign(globalThis, { DOMParser: dom.DOMParser }); });
  afterAll(() => { Object.assign(globalThis, { DOMParser: saved }); });

  test('puts its policy ahead of a script written before <html>, and its sent answer ahead of every script', () => {
    const page = lockDownReceivedDocument('<script>fetch("https://x.test")</script><html><head><script>boot()</script></head><body>hi</body></html>', { pick: '</script>b' });
    // A parser may put the early script in the head or the body; either way it comes after both.
    expect(page.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(page.indexOf('id="oc-share-answer"')).toBeLessThan(page.indexOf('<script>'));
    expect(page.indexOf('<script>')).toBeLessThan(page.indexOf('fetch('));
    expect(page).toContain("connect-src 'none'");
    // The answer cannot end its own script element.
    expect(page).toContain('\\u003c/script>b');
    expect(lockDownReceivedDocument('<p>x</p>', null)).not.toContain('oc-share-answer');
  });

  test('sits inside a small data: shell that allows no frame navigation and takes the page as a message', () => {
    const shell = decodeURIComponent(buildReceivedPageShell('dark', 'No').replace(/^data:text\/html;charset=utf-8,/, ''));
    expect(buildReceivedPageShell('dark', 'No').startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(shell).toContain("frame-src 'none'");
    expect(shell.match(/<\/script>/g)).toHaveLength(1);
    expect(shell).toContain('color-scheme:dark');
  });
});

/** A window the shell talks to, as it sees one. */
type Party = { postMessage: (message: JsonValue) => void };

/** The shell's script, run with stand-in windows: the page below it, the app above it, the user's activation. */
const runShell = ({ activationApi = true } = {}) => {
  const shell = decodeURIComponent(buildReceivedPageShell('light', 'Answers are sent from a click').replace(/^data:text\/html;charset=utf-8,/, ''));
  const script = /<script>([\s\S]*)<\/script>/.exec(shell)?.[1] ?? '';
  const toPage: JsonValue[] = [];
  const toApp: JsonValue[] = [];
  const page: Party = { postMessage: (message) => { toPage.push(message); } };
  const app: Party = { postMessage: (message) => { toApp.push(message); } };
  const frameEvents = new EventTarget();
  const frame = { contentWindow: page, srcdoc: '', addEventListener: frameEvents.addEventListener.bind(frameEvents) };
  const events = new EventTarget();
  const activation = { isActive: false };
  new Function('window', 'document', 'navigator', script)(
    { parent: app, addEventListener: events.addEventListener.bind(events) },
    { querySelector: () => frame },
    activationApi ? { userActivation: activation } : {},
  );
  const send = (source: Party, data: JsonValue) => events.dispatchEvent(Object.assign(new Event('message'), { source, data }));
  // The app hands the page over; the frame then loads it.
  const show = (html = '<p>page</p>') => {
    send(app, { source: 'openchamber-share-host', type: 'page', page: html });
    frameEvents.dispatchEvent(new Event('load'));
  };
  return { toPage, toApp, page, app, activation, send, frame, show };
};

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the shell between the app and a received page', () => {
  const submit = { source: 'openchamber-share-document', type: 'submit', data: { pick: 'b' }, summary: 'B' };
  const refusal = { source: 'openchamber-share-viewer', type: 'submit-result', ok: false, error: 'Answers are sent from a click' };

  test('shows the first page the app hands over, and no later one', () => {
    const shell = runShell();
    shell.show();
    shell.send(shell.app, { source: 'openchamber-share-host', type: 'page', page: '<p>swapped</p>' });
    shell.send(shell.page, { source: 'openchamber-share-host', type: 'page', page: '<p>from the page</p>' });
    expect(shell.frame.srcdoc).toBe('<p>page</p>');
  });

  test('refuses an answer posted with no gesture after the page showed, even while the click that opened it is still active', async () => {
    const shell = runShell();
    // The click on Open is still active as the page loads and posts at once.
    shell.activation.isActive = true;
    shell.show();
    shell.send(shell.page, submit);
    await tick(450);
    shell.send(shell.page, submit);
    expect(shell.toApp).toEqual([]);
    expect(shell.toPage).toEqual([refusal, refusal]);
    // Once that activation lapsed, a new gesture in the page lets the answer through, rebuilt from its known fields.
    shell.activation.isActive = false;
    await tick(250);
    shell.activation.isActive = true;
    shell.send(shell.page, { ...submit, extra: 'dropped' });
    expect(shell.toApp).toEqual([{ ...submit, verified: true }]);
  });

  test('without the activation API, passes the answer up marked unverified, for the app to confirm', async () => {
    const shell = runShell({ activationApi: false });
    shell.show();
    shell.send(shell.page, submit);
    await tick(250);
    expect(shell.toPage).toEqual([]);
    expect(shell.toApp).toEqual([{ ...submit, verified: false }]);
  });

  test('forwards only what the protocol names, in both directions', async () => {
    const shell = runShell();
    shell.show();
    await tick(250);
    shell.activation.isActive = true;
    shell.send(shell.page, { source: 'openchamber-share-viewer', type: 'submit-result', ok: true });
    shell.send(shell.page, { source: 'openchamber-share-document', type: 'other' });
    shell.send(shell.page, 'text');
    expect(shell.toApp).toEqual([]);
    shell.send(shell.app, { source: 'openchamber-share-viewer', type: 'init', wantsAnswer: true, locale: 'uk', answer: { a: 1 }, extra: 1 });
    shell.send(shell.app, { source: 'openchamber-share-document', type: 'submit', summary: 'x' });
    shell.send(shell.app, { source: 'openchamber-share-viewer', type: 'surprise' });
    shell.send({ postMessage: () => undefined }, { source: 'openchamber-share-viewer', type: 'submit-result', ok: true });
    expect(shell.toPage).toEqual([{ source: 'openchamber-share-viewer', type: 'init', wantsAnswer: true, locale: 'uk', answer: { a: 1 } }]);
  });
});
