import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { connectHost, HostRequestError, type HostFrame } from './host.ts';
import {
  GUEST_ATTACH_TITLE_MAX,
  GUEST_FILE_CONTENT_MAX,
  GUEST_FILE_PATH_MAX,
  type GuestMessage,
  type HostMessage,
} from './contract.ts';

type Listener = (event: Event) => void;

const createFrame = (): HostFrame & { dispatch: (event: Event) => void; posted: GuestMessage[] } => {
  const listeners = new Set<Listener>();
  const posted: GuestMessage[] = [];
  const postMessage = (message: GuestMessage) => {
    posted.push(message);
  };
  return {
    parent: { postMessage },
    postMessage,
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    dispatch: (event: Event) => {
      for (const listener of listeners) listener(event);
    },
    posted,
  };
};

const ready: HostMessage = {
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: OPENCHAMBER_SDK_API_VERSION,
  type: 'ready',
  payload: {
    theme: {
      mode: 'dark',
      tokens: {
        background: '#111',
        elevated: '#1a1a1a',
        foreground: '#eee',
        muted: '#666',
        subtle: '#222',
        border: '#333',
        hover: '#2a2a2a',
        selection: '#334',
        focus: '#4af',
        primary: '#4af',
        font: 'SF Pro Text, sans-serif',
        mutedSurface: '#f4f4f5',
        elevatedForeground: '#111111',
        active: '#e5e5e5',
        selectionForeground: '#111111',
        primaryForeground: '#ffffff',
        success: '#16a34a',
        warning: '#d97706',
        error: '#dc2626',
        info: '#2563eb',
        mono: 'Menlo, monospace',
        radius: '0.5625rem',
      },
    },
    locale: 'en',
    directory: '/repo',
    session: { id: 'ses-1', title: 'Hello', busy: false },
    surface: 'panel',
    connection: { connected: false, account: '' },
    settings: {},
    item: null,
  },
};

const demoItem = {
  providerId: 'tasks-demo',
  id: 'DEMO-1',
  title: 'Fix the login redirect loop',
  url: 'https://example.com/tasks/DEMO-1',
  kind: 'issue' as const,
};

describe('connectHost', () => {
  test('sends hello and delivers ready from the parent frame only', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    expect(parent.posted[0]).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'hello',
    });

    const seen: string[] = [];
    host.onReady((context) => {
      seen.push(context.directory ?? '');
    });

    guest.dispatch(new MessageEvent('message', { data: ready }));
    expect(seen).toEqual(['/repo']);

    guest.dispatch(new Event('click'));
    expect(seen).toEqual(['/repo']);

    host.dispose();
  });

  test('replays the last ready to a late listener', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', { data: ready }));

    let locale = '';
    host.onReady((context) => {
      locale = context.locale;
    });
    expect(locale).toBe('en');
    host.dispose();
  });

  test('delivers a session push', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    const seen: Array<string | null> = [];
    host.onSession((session) => {
      seen.push(session?.title ?? null);
    });
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'session',
        payload: { session: { id: 'ses-2', title: 'Later' } },
      },
    }));
    expect(seen).toEqual(['Later']);
    host.dispose();
  });

  test('delivers the ready item and replays it to a late listener', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', {
      data: { ...ready, payload: { ...ready.payload, item: demoItem } },
    }));

    const seen: Array<string | null> = [];
    host.onItem((item) => {
      seen.push(item?.id ?? null);
    });
    expect(seen).toEqual(['DEMO-1']);

    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: OPENCHAMBER_SDK_API_VERSION,
        type: 'item',
        payload: { item: null },
      },
    }));
    expect(seen).toEqual(['DEMO-1', null]);

    let readyItem: string | null = 'unset';
    host.onReady((context) => {
      readyItem = context.item?.id ?? null;
    });
    expect(readyItem).toBeNull();
    host.dispose();
  });

  test('replays the last directory to a late listener', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', { data: ready }));

    let directory = '';
    host.onDirectory((next) => {
      directory = next ?? '';
    });
    expect(directory).toBe('/repo');
    host.dispose();
  });

  test('keeps lastReady current after a directory and session push', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', { data: ready }));
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'directory',
        payload: { directory: '/other' },
      },
    }));
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'session',
        payload: { session: { id: 'ses-9', title: 'Later' } },
      },
    }));

    let directory = '';
    let title = '';
    host.onDirectory((next) => {
      directory = next ?? '';
    });
    host.onSession((session) => {
      title = session?.title ?? '';
    });
    expect(directory).toBe('/other');
    expect(title).toBe('Later');
    host.dispose();
  });

  test('replays the last session lifecycle to a late listener', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', { data: ready }));

    const seen: string[] = [];
    host.onSessionLifecycle((event) => {
      seen.push(`${event.sessionId}:${event.phase}`);
    });
    expect(seen).toEqual(['ses-1:completed']);

    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'session-lifecycle',
        payload: { sessionId: 'ses-1', phase: 'started' },
      },
    }));
    expect(seen).toEqual(['ses-1:completed', 'ses-1:started']);
    host.dispose();
  });

  test('replays the last session to a late listener', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', { data: ready }));

    let title = '';
    host.onSession((session) => {
      title = session?.title ?? '';
    });
    expect(title).toBe('Hello');
    host.dispose();
  });

  test('resolves toast when the host answers ok', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    const toast = host.toast({ kind: 'info', message: 'Hello' });
    const request = parent.posted[1];
    expect(request?.type).toBe('toast');
    if (request?.type !== 'toast') {
      throw new Error('expected toast');
    }

    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'result',
        id: request.id,
        ok: true,
      },
    }));

    await toast;
    host.dispose();
  });

  test('rejects when the page is not framed', async () => {
    const top = createFrame();
    top.parent = top;
    const host = connectHost({ target: top });
    try {
      await host.toast({ kind: 'info', message: 'Hello' });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HostRequestError);
      if (error instanceof HostRequestError) {
        expect(error.code).toBe('HOST_UNAVAILABLE');
      }
    }
    host.dispose();
  });

  test('posts clipboard-write and compose', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    const write = host.writeClipboard('/repo');
    const compose = host.compose({ text: 'Hello from the guest' });
    const writeRequest = parent.posted[1];
    const composeRequest = parent.posted[2];
    if (writeRequest?.type !== 'clipboard-write' || composeRequest?.type !== 'compose') {
      throw new Error('expected clipboard-write and compose');
    }

    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: writeRequest.id, ok: true },
    }));
    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: composeRequest.id, ok: true },
    }));
    await Promise.all([write, compose]);
    host.dispose();
  });

  test('posts attach and close', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;

    const host = connectHost({ target: guest, acceptSource: () => true });
    const attach = host.attach({
      providerId: 'hello',
      id: 'HELLO-1',
      title: 'Sample ticket',
      url: 'https://example.com/HELLO-1',
    });
    const close = host.close();
    const attachRequest = parent.posted[1];
    const closeRequest = parent.posted[2];
    if (attachRequest?.type !== 'attach' || closeRequest?.type !== 'close') {
      throw new Error('expected attach and close');
    }

    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: attachRequest.id, ok: true },
    }));
    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: closeRequest.id, ok: true },
    }));
    await Promise.all([attach, close]);
    host.dispose();
  });

  test('clamps attach title before post', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const title = 'x'.repeat(240);
    const attach = host.attach({
      providerId: 'clickup',
      id: 'abc',
      title,
      url: 'https://app.clickup.com/t/abc',
    });
    const attachRequest = parent.posted[1];
    if (attachRequest?.type !== 'attach') {
      throw new Error('expected attach');
    }
    expect(attachRequest.payload.title).toHaveLength(GUEST_ATTACH_TITLE_MAX);
    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: attachRequest.id, ok: true },
    }));
    await attach;
    host.dispose();
  });

  test('posts a pull attach with author and branches', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const attach = host.attach({
      providerId: 'gitlab',
      id: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      kind: 'pull',
      author: 'ada',
      branches: { head: 'feature', base: 'main' },
    });
    const attachRequest = parent.posted[1];
    if (attachRequest?.type !== 'attach') {
      throw new Error('expected attach');
    }
    expect(attachRequest.payload).toMatchObject({
      kind: 'pull',
      author: 'ada',
      branches: { head: 'feature', base: 'main' },
    });
    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: attachRequest.id, ok: true },
    }));
    await attach;
    host.dispose();
  });

  test('posts start-session with a worktree flag', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const start = host.startSession({
      providerId: 'gitlab',
      id: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      kind: 'pull',
      worktree: true,
    });
    const posted = parent.posted[1];
    if (posted?.type !== 'start-session') {
      throw new Error('expected start-session');
    }
    expect(posted.payload.worktree).toBe(true);
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'result',
        id: posted.id,
        ok: true,
        payload: { sessionId: 'ses-9', sent: 'skipped' },
      },
    }));
    expect(await start).toEqual({ sessionId: 'ses-9', sent: 'skipped' });
    host.dispose();
  });

  test('posts prompt and session-link', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const prompt = host.prompt({ text: 'Fix the login', send: true });
    const link = host.sessionLink({
      providerId: 'gitlab',
      id: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
    });
    const promptRequest = parent.posted[1];
    const linkRequest = parent.posted[2];
    if (promptRequest?.type !== 'prompt' || linkRequest?.type !== 'session-link') {
      throw new Error('expected prompt and session-link');
    }
    expect(promptRequest.payload).toEqual({ text: 'Fix the login', send: true });
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'result',
        id: promptRequest.id,
        ok: true,
        payload: { sent: 'sent' },
      },
    }));
    guest.dispatch(new MessageEvent('message', {
      data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: linkRequest.id, ok: true },
    }));
    expect(await prompt).toEqual({ sent: 'sent' });
    await link;
    host.dispose();
  });

  test('rejects prompt when the session is busy', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const pending = host.prompt({ text: 'Wait', send: true });
    const posted = parent.posted[1];
    if (posted?.type !== 'prompt') {
      throw new Error('expected prompt');
    }
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'result',
        id: posted.id,
        ok: false,
        error: 'Session is busy.',
        code: 'SESSION_BUSY',
      },
    }));
    try {
      await pending;
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HostRequestError);
      if (error instanceof HostRequestError) {
        expect(error.code).toBe('SESSION_BUSY');
      }
    }
    host.dispose();
  });

  test('replays connection and settings from ready', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    guest.dispatch(new MessageEvent('message', {
      data: {
        ...ready,
        payload: {
          ...ready.payload,
          connection: { connected: true, account: 'ada' },
          settings: { 'list-id': '123' },
        },
      },
    }));

    let account = '';
    let listId = '';
    host.onConnection((connection) => {
      account = connection.account;
    });
    host.onSettings((settings) => {
      listId = settings['list-id'] ?? '';
    });
    expect(account).toBe('ada');
    expect(listId).toBe('123');
    host.dispose();
  });

  test('resolves request with the host payload', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const pending = host.request({ method: 'GET', path: '/api/v2/user' });
    const posted = parent.posted[1];
    if (posted?.type !== 'request') {
      throw new Error('expected request');
    }
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'result',
        id: posted.id,
        ok: true,
        payload: { status: 200, body: '{"user":{"username":"ada"}}' },
      },
    }));
    await expect(pending).resolves.toEqual({
      status: 200,
      body: '{"user":{"username":"ada"}}',
    });
    host.dispose();
  });

  test('posts file calls and narrows their results', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const answer = (index: number, type: GuestMessage['type'], payload: object) => {
      const posted = parent.posted[index];
      if (posted?.type !== type || !('id' in posted)) {
        throw new Error(`expected ${type}`);
      }
      guest.dispatch(new MessageEvent('message', {
        data: { channel: OPENCHAMBER_SDK_CHANNEL, v: 1, type: 'result', id: posted.id, ok: true, payload },
      }));
      return posted;
    };
    const read = host.readFile('README.md');
    expect(answer(1, 'file-read', { content: '# hi' })).toMatchObject({ payload: { path: 'README.md' } });
    await expect(read).resolves.toEqual({ content: '# hi' });

    const write = host.writeFile('notes.txt', 'x');
    expect(answer(2, 'file-write', { written: true })).toMatchObject({ payload: { path: 'notes.txt', content: 'x' } });
    await expect(write).resolves.toEqual({ written: true });

    const list = host.listDir('.');
    answer(3, 'file-list', { entries: [{ name: 'a', kind: 'file' }] });
    await expect(list).resolves.toEqual({ entries: [{ name: 'a', kind: 'file' }] });

    const stat = host.stat('~/.config/x');
    answer(4, 'file-stat', { kind: 'missing', size: 0, mtime: 0 });
    await expect(stat).resolves.toEqual({ kind: 'missing', size: 0, mtime: 0 });

    // A wrong-shaped answer is a host refusal, not a silently wrong value.
    const mismatch = host.readFile('a');
    answer(5, 'file-read', { written: true });
    await expect(mismatch).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    host.dispose();
  });

  test('refuses a bad file path or oversized content without posting', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    await expect(host.readFile('')).rejects.toMatchObject({ code: 'BAD_PATH' });
    await expect(host.stat('x'.repeat(GUEST_FILE_PATH_MAX + 1))).rejects.toMatchObject({ code: 'BAD_PATH' });
    await expect(host.writeFile('a', 'x'.repeat(GUEST_FILE_CONTENT_MAX + 1))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(parent.posted).toHaveLength(1);
    host.dispose();
  });

  test('rejects a request with the host error code', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const pending = host.request({ method: 'GET', path: '/api/v2/user' });
    const posted = parent.posted[1];
    if (posted?.type !== 'request') {
      throw new Error('expected request');
    }
    guest.dispatch(new MessageEvent('message', {
      data: {
        channel: OPENCHAMBER_SDK_CHANNEL,
        v: 1,
        type: 'result',
        id: posted.id,
        ok: false,
        error: 'Not connected.',
        code: 'DISCONNECTED',
      },
    }));
    try {
      await pending;
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HostRequestError);
      if (error instanceof HostRequestError) {
        expect(error.code).toBe('DISCONNECTED');
        expect(error.message).toBe('Not connected.');
      }
    }
    host.dispose();
  });

  test('rejects when the host stays silent past the timeout', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({
      target: guest,
      acceptSource: () => true,
      requestTimeoutMs: 5,
    });
    try {
      await host.request({ method: 'GET', path: '/api/v2/user' });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HostRequestError);
      if (error instanceof HostRequestError) {
        expect(error.code).toBe('HOST_TIMEOUT');
      }
    }
    host.dispose();
  });
});

describe('connectHost resolve and badge', () => {
  const resolveMessage = (id: string, command: string, args: string): HostMessage => ({
    channel: OPENCHAMBER_SDK_CHANNEL,
    v: OPENCHAMBER_SDK_API_VERSION,
    type: 'resolve',
    id,
    payload: { command, args },
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('answers resolve with the handler item, null, or an error, and refuses without a handler', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });

    guest.dispatch(new MessageEvent('message', { data: resolveMessage('r-0', 'task', '1') }));
    await flush();
    expect(parent.posted[1]).toMatchObject({ type: 'resolve-result', id: 'r-0', payload: { error: 'This extension does not resolve commands.' } });

    const seen: Array<{ command: string; args: string }> = [];
    const off = host.onResolve(async (request) => {
      seen.push(request);
      if (request.args === 'none') return null;
      if (request.args === 'boom') throw new Error('Task service is down');
      return { ...demoItem, title: `${demoItem.title} `.repeat(40) };
    });

    guest.dispatch(new MessageEvent('message', { data: resolveMessage('r-1', 'task', 'DEMO-1') }));
    guest.dispatch(new MessageEvent('message', { data: resolveMessage('r-2', 'task', 'none') }));
    guest.dispatch(new MessageEvent('message', { data: resolveMessage('r-3', 'task', 'boom') }));
    await flush();

    expect(seen).toEqual([
      { command: 'task', args: 'DEMO-1' },
      { command: 'task', args: 'none' },
      { command: 'task', args: 'boom' },
    ]);
    const answers = parent.posted.filter((message) => message.type === 'resolve-result');
    expect(answers).toHaveLength(4);
    expect(answers[1]).toMatchObject({ id: 'r-1', payload: { item: { id: 'DEMO-1', kind: 'issue' } } });
    if (answers[1]?.type === 'resolve-result' && 'item' in answers[1].payload && answers[1].payload.item) {
      expect(answers[1].payload.item.title.length).toBe(GUEST_ATTACH_TITLE_MAX);
    }
    expect(answers[2]).toMatchObject({ id: 'r-2', payload: { item: null } });
    expect(answers[3]).toMatchObject({ id: 'r-3', payload: { error: 'Task service is down' } });

    off();
    guest.dispatch(new MessageEvent('message', { data: resolveMessage('r-4', 'task', 'x') }));
    await flush();
    expect(parent.posted.at(-1)).toMatchObject({ id: 'r-4', payload: { error: 'This extension does not resolve commands.' } });
    host.dispose();
  });

  test('setBadge clamps to 0..999 and sends null to clear', async () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });

    const calls = [3, 5000, -2, 2.6, null].map((count) => host.setBadge(count).catch(() => undefined));
    const badges = parent.posted.filter((message) => message.type === 'badge');
    expect(badges.map((message) => (message.type === 'badge' ? message.payload.count : undefined))).toEqual([3, 999, 0, 3, null]);
    host.dispose();
    await Promise.all(calls);
  });

  test('replays a message item to a late onItem listener', () => {
    const parent = createFrame();
    const guest = createFrame();
    guest.parent = parent.parent;
    const host = connectHost({ target: guest, acceptSource: () => true });
    const messageItem = {
      kind: 'message' as const,
      action: 'create-task',
      sessionId: 'ses-1',
      sessionTitle: 'Hello',
      directory: '/repo',
      messageId: 'msg-1',
      role: 'assistant' as const,
      text: 'Do the thing.',
    };
    guest.dispatch(new MessageEvent('message', { data: { ...ready, payload: { ...ready.payload, item: messageItem } } }));
    const seen: unknown[] = [];
    host.onItem((item) => seen.push(item));
    expect(seen).toEqual([messageItem]);
    host.dispose();
  });
});
