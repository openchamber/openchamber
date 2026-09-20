import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { guestMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage, HostReadyContext, HostResultPayload, GuestWorkspaceSnapshot } from '@openchamber/sdk';

const examples = new URL('../../../../sdk/examples/', import.meta.url);
const windows: Window[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const context: HostReadyContext = {
  locale: 'en', directory: '/repo', session: null, surface: 'panel', connection: { connected: false, account: '' }, settings: {}, item: null,
  theme: { mode: 'light', tokens: {
    background: '#fff', elevated: '#fff', foreground: '#111', muted: '#666', subtle: '#eee', border: '#ccc', hover: '#eee',
    selection: '#ddd', focus: '#444', primary: '#444', font: 'sans-serif', mutedSurface: '#eee', elevatedForeground: '#111',
    active: '#ddd', selectionForeground: '#111', primaryForeground: '#fff', primaryText: '#444', successText: '#444',
    warningText: '#444', errorText: '#444', infoText: '#444', success: '#444', warning: '#444', error: '#444', info: '#444', mono: 'monospace', radius: '8px',
  } },
};

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

const load = async (name: string, script = 'main', folder = 'panel') => {
  const parent = new Window();
  const window = new Window({ settings: { disableJavaScriptEvaluation: false } });
  windows.push(window, parent);
  Object.defineProperty(window, 'parent', { value: parent });
  window.document.body.innerHTML = '<div id="root"></div>';
  const messages: GuestMessage[] = [];
  spyOn(parent, 'postMessage').mockImplementation((data) => { messages.push(guestMessageSchema.parse(data)); });
  const send = (message: HostMessage) => window.dispatchEvent(new window.MessageEvent('message', { source: parent, data: message }));
  const ready = (next: HostReadyContext = context) => send({ channel: 'openchamber.sdk', v: 1, type: 'ready', payload: next });
  const reply = (message: GuestMessage, payload?: HostResultPayload) => {
    if (!('id' in message)) throw new Error('Cannot reply to hello');
    send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload });
  };
  const request = (type: GuestMessage['type']) => {
    const result = [...messages].reverse().find((message) => message.type === type);
    if (!result) throw new Error(`Missing ${type}`);
    return result;
  };
  const button = (label: string) => {
    const result = [...window.document.querySelectorAll('button')].find((element) => element.textContent === label);
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  };
  const update = (snapshot: GuestWorkspaceSnapshot) => {
    const subscription = [...messages].reverse().find((message) => message.type === 'workspace-subscribe' && message.payload.query.kind === snapshot.kind
      && (snapshot.kind === 'projects' || ('projectId' in message.payload.query && message.payload.query.projectId === snapshot.projectId)));
    if (!subscription || subscription.type !== 'workspace-subscribe') throw new Error(`Missing ${snapshot.kind} subscription`);
    reply(subscription);
    send({ channel: 'openchamber.sdk', v: 1, type: 'workspace', payload: { subscriptionId: subscription.payload.subscriptionId, snapshot } });
  };
  runInNewContext(await readFile(new URL(`${name}/${folder}/${script}.js`, examples), 'utf8'), {
    window, document: window.document, HTMLElement: window.HTMLElement, MessageEvent: window.MessageEvent, console,
    HTMLInputElement: window.HTMLInputElement, HTMLStyleElement: window.HTMLStyleElement, HTMLAnchorElement: window.HTMLAnchorElement,
    TextEncoder, URL, crypto, performance, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
  });
  return { window, messages, send, ready, reply, request, button, update };
};

describe('checked-in SDK examples', () => {
  test('a background message action shows one toast without drawing the panel', async () => {
    const app = await load('hello-kit', 'main', 'background');
    app.ready({ ...context, surface: 'background' });
    app.send({ channel: 'openchamber.sdk', v: 1, type: 'action', id: 'count', payload: {
      kind: 'message', action: 'message-length', sessionId: 's1', sessionTitle: 'Example', directory: '/repo', messageId: 'm1', role: 'user', text: 'Hello',
    } });
    await tick();
    expect(app.request('toast')).toMatchObject({ payload: { kind: 'info', message: 'Message length: 5 characters.', copy: true, dismiss: true, persistent: true } });
    expect(app.messages.some((message) => message.type === 'action-result')).toBe(false);
    app.ready({ ...context, surface: 'background' });
    expect(app.messages.filter((message) => message.type === 'toast')).toHaveLength(1);
    expect(app.window.document.querySelector('button')).toBeNull();
    app.reply(app.request('toast'));
    await tick();
    expect(app.request('action-result')).toMatchObject({ id: 'count', payload: { ok: true } });
  });

  test('hello kit keeps controls and input state across theme snapshots', async () => {
    const app = await load('hello-kit');
    app.ready();
    const input = app.window.document.querySelector('input');
    if (!input) throw new Error('Missing name field');
    input.value = 'Keep this draft';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    const controls = app.window.document.querySelectorAll('button').length;
    app.ready({ ...context, theme: { ...context.theme, mode: 'dark' } });
    expect(app.window.document.querySelector('input')).toBe(input);
    expect(input.value).toBe('Keep this draft');
    expect(app.window.document.querySelectorAll('button').length).toBe(controls);
    expect(app.window.document.documentElement.dataset.ocTheme).toBe('dark');
    app.button('Compose').click();
    expect(app.request('compose').type).toBe('compose');
    app.reply(app.request('compose'));
  });

  test('GitHub ignores repeated ready and discards replies after disconnect', async () => {
    const app = await load('github-token');
    const connected = { ...context, connection: { connected: true, account: 'fixture' } };
    app.ready(connected);
    const pending = app.request('request');
    app.ready(connected);
    expect(app.messages.filter((message) => message.type === 'request').length).toBe(1);
    app.send({ channel: 'openchamber.sdk', v: 1, type: 'connection', payload: { connection: context.connection } });
    app.reply(pending, { status: 200, body: JSON.stringify([{ full_name: 'private/repository', html_url: 'https://example.com/repo', description: null, stargazers_count: 0, private: true }]) });
    await tick();
    expect(app.window.document.body.textContent).toContain('Not connected');
    expect(app.window.document.body.textContent).not.toContain('private/repository');
  });

  test('service panel sends typed requests and retains its input', async () => {
    const app = await load('service-echo');
    app.ready();
    app.reply(app.request('service-status'), { status: 'stopped' });
    await tick();
    const input = app.window.document.querySelector('textarea');
    if (!input) throw new Error('Missing message field');
    input.value = 'Echo this';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.ready();
    expect(input.value).toBe('Echo this');
    app.button('Send request').click();
    const request = app.request('service-request');
    if (request.type !== 'service-request') throw new Error('Missing service request');
    expect(request.payload.body).toBe('{"message":"Echo this"}');
    app.reply(request, { status: 200, body: '{"echo":"Echo this"}' });
    await tick();
    app.reply(app.request('service-status'), { status: 'ready' });
    expect(app.window.document.body.textContent).toContain('HTTP 200');
  });

  test('repository refresh failures preserve results and context is composed without sending', async () => {
    const app = await load('github-token');
    app.ready({ ...context, connection: { connected: true, account: 'fixture' } });
    app.reply(app.request('request'), { status: 200, body: JSON.stringify([{ full_name: 'example/repo', html_url: 'https://github.com/example/repo', description: 'A useful project', stargazers_count: 12, private: false }]) });
    await tick();
    app.button('Add context to chat').click();
    const compose = app.request('compose');
    if (compose.type !== 'compose') throw new Error('Missing compose');
    expect(compose.payload.text).toContain('example/repo');
    app.reply(compose);
    app.button('Refresh').click();
    app.reply(app.request('request'), { status: 503, body: 'Unavailable' });
    await tick();
    expect(app.window.document.body.textContent).toContain('example/repo');
    expect(app.window.document.body.textContent).toContain('HTTP 503');
    expect(app.messages.some((message) => message.type === 'prompt' || message.type === 'start-session')).toBe(false);
  });

  test('task commands resolve without ready and repeated ready keeps the panel', async () => {
    const app = await load('tasks-demo');
    app.send({ channel: 'openchamber.sdk', v: 1, type: 'resolve', id: 'command', payload: { command: 'task', args: 'DEMO-2' } });
    await tick();
    app.reply(app.request('storage'), { storage: true, op: 'keys', keys: [] });
    await tick();
    const result = app.request('resolve-result');
    if (result.type !== 'resolve-result' || !('item' in result.payload)) throw new Error('Missing task result');
    expect(result.payload.item?.id).toBe('DEMO-2');
    app.ready();
    for (const message of [...app.messages]) {
      if (message.type === 'storage' && message.payload.op === 'keys') app.reply(message, { storage: true, op: 'keys', keys: [] });
      if (message.type === 'storage' && message.payload.op === 'get') app.reply(message, { storage: true, op: 'get', found: false });
    }
    await tick();
    app.reply(app.request('badge'));
    const input = app.window.document.querySelector('input');
    if (!input) throw new Error('Missing task search');
    input.value = 'DEMO-2';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.ready();
    expect(input.value).toBe('DEMO-2');
    expect(app.window.document.querySelectorAll('h1').length).toBe(1);
    expect(app.messages.filter((message) => message.type === 'badge').length).toBe(1);
  });

  test('config null is data and repeated ready preserves a raw draft', async () => {
    const app = await load('config-editor');
    app.ready();
    app.reply(app.request('file-stat'), { kind: 'file', size: 4, mtime: 0 });
    await tick();
    app.reply(app.request('file-read'), { content: 'null' });
    await tick();
    expect(app.window.document.body.textContent).not.toContain('No config yet');
    app.button('Raw').click();
    const input = app.window.document.querySelector('textarea');
    if (!input) throw new Error('Missing editor');
    input.value = '{"draft":true}';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.ready();
    expect(app.window.document.querySelector('textarea')).toBe(input);
    app.button('Explore').click(); app.button('Raw').click();
    expect(app.window.document.querySelector('textarea')?.value).toBe('{"draft":true}');
    app.button('Review changes').click();
    app.button('Save').click();
    const pending = app.request('file-write');
    app.button('Back to editor').click();
    const newer = app.window.document.querySelector('textarea');
    if (!newer) throw new Error('Missing editor during save');
    newer.value = '{"draft":"newer"}';
    newer.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.reply(pending, { written: true });
    await tick();
    app.reply(app.request('toast'));
    await tick();
    expect(app.window.document.querySelector('textarea')?.value).toBe('{"draft":"newer"}');
    expect(app.messages.filter((message) => message.type === 'file-read').length).toBe(1);
  });

  test('board loads projects even when notes fail and preserves scope on failed project snapshots', async () => {
    const app = await load('tasks-demo', 'page');
    app.ready({ ...context, surface: 'page' });
    const storage = app.request('storage');
    if (!('id' in storage)) throw new Error('Missing storage request');
    app.send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: storage.id, ok: false, error: 'Storage unavailable', code: 'HOST_REJECTED' });
    app.update({ kind: 'projects', state: 'ready', projects: [{ id: 'a', name: 'Project A', directory: '/a' }] });
    await tick();
    app.update({ kind: 'sessions', projectId: 'a', state: 'ready', coverage: [], sessions: [{ id: 'session-a', title: 'Session A', projectId: 'a', directory: '/a', parentId: null,
      createdAt: 0, updatedAt: 0, archivedAt: null, worktree: null, activity: 'idle', outcome: null, items: [] }] });
    await tick();
    app.update({ kind: 'worktrees', projectId: 'a', state: 'ready', worktrees: [{ directory: '/a/branch', name: 'Branch A', branch: 'a', status: 'ready' }] });
    await tick();
    app.update({ kind: 'projects', state: 'error', projects: [] });
    expect(app.window.document.body.textContent).toContain('Session A');
    expect(app.window.document.body.textContent).toContain('Project A');
    app.update({ kind: 'projects', state: 'ready', projects: [{ id: 'b', name: 'Project B', directory: '/b' }] });
    expect(app.window.document.body.textContent).not.toContain('Session A');
    app.button('Project root').click();
    expect(app.window.document.body.textContent).not.toContain('Branch A');
  });

  test('conversation previews never render message text as remote images', async () => {
    const app = await load('tasks-demo', 'attach');
    app.ready({ ...context, surface: 'dialog', item: { kind: 'session', action: 'summarize', sessionId: 's', sessionTitle: 'Example', directory: '/repo',
      messages: [{ id: 'm', role: 'assistant', text: '![private](https://example.com/image)', createdAt: 0 }] } });
    expect(app.window.document.body.textContent).toContain('![private](https://example.com/image)');
    expect(app.window.document.querySelector('img')).toBeNull();
  });
});
