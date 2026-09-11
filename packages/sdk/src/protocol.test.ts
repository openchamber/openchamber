import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import {
  clampAttachRequest,
  clampPromptRequest,
  clampStartSessionRequest,
  GUEST_ATTACH_DATA_MAX,
  GUEST_ATTACH_TITLE_MAX,
  GUEST_COMPOSE_TEXT_MAX,
  readHostMessage,
} from './contract.ts';
import {
  guestMessageSchema,
  hostMessageSchema,
  parseGuestMessage,
  parseHostMessage,
} from './protocol.ts';

const readyPayload = {
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
  locale: 'uk',
  directory: '/repo',
  session: { id: 'ses-1', title: 'Hello', busy: false },
  surface: 'panel',
  connection: { connected: false, account: '' },
  settings: {},
  item: null,
};

describe('parseHostMessage', () => {
  test('accepts ready', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'ready',
      payload: readyPayload,
    });
    expect(message).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: readyPayload,
    });
  });

  test('accepts a null directory', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'directory',
      payload: { directory: null },
    });
    expect(message?.type).toBe('directory');
    if (message?.type === 'directory') {
      expect(message.payload.directory).toBeNull();
    }
  });

  test('drops a message from another channel or version', () => {
    expect(hostMessageSchema.safeParse({
      channel: 'other',
      v: 1,
      type: 'ready',
      payload: readyPayload,
    }).success).toBe(false);
    expect(hostMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 2,
      type: 'ready',
      payload: readyPayload,
    }).success).toBe(false);
  });

  test('accepts a null session push', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session',
      payload: { session: null },
    });
    expect(message?.type).toBe('session');
    if (message?.type === 'session') {
      expect(message.payload.session).toBeNull();
    }
  });

  test('drops ready without a surface field', () => {
    expect(hostMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: {
        theme: readyPayload.theme,
        locale: readyPayload.locale,
        directory: readyPayload.directory,
        session: readyPayload.session,
      },
    }).success).toBe(false);
  });

  test('accepts an attach dialog surface', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: { ...readyPayload, surface: 'dialog' },
    });
    expect(message?.type).toBe('ready');
    if (message?.type === 'ready') {
      expect(message.payload.surface).toBe('dialog');
    }
  });

  test('accepts ready with an attached item and an item push', () => {
    const item = {
      providerId: 'tasks-demo',
      id: 'DEMO-1',
      title: 'Fix the login redirect loop',
      url: 'https://example.com/tasks/DEMO-1',
      kind: 'issue' as const,
    };
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: { ...readyPayload, item },
    });
    expect(message?.type).toBe('ready');
    if (message?.type === 'ready') {
      expect(message.payload.item).toEqual(item);
    }
    const push = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'item',
      payload: { item: null },
    });
    expect(push).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'item',
      payload: { item: null },
    });
  });

  test('keeps attach data within the limit and refuses it over the limit', () => {
    const data = { status: 'open', comments: [{ author: 'mara', text: 'hi' }], n: 1, ok: true, none: null };
    const base = {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach' as const,
      id: 'oc-1',
    };
    const payload = { providerId: 'tasks-demo', id: 'DEMO-1', title: 'T', url: 'https://x.test/1' };
    const parsed = guestMessageSchema.safeParse({ ...base, payload: { ...payload, data } });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'attach') {
      expect(parsed.data.payload.data).toEqual(data);
    }
    expect(guestMessageSchema.safeParse({
      ...base,
      payload: { ...payload, data: 'x'.repeat(GUEST_ATTACH_DATA_MAX) },
    }).success).toBe(false);
    expect(parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'item',
      payload: { item: { ...payload, data } },
    })).toMatchObject({ type: 'item', payload: { item: { data } } });
  });

  test('drops ready without an item field', () => {
    const { item: _item, ...withoutItem } = readyPayload;
    void _item;
    expect(hostMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: withoutItem,
    }).success).toBe(false);
  });

  test('drops ready without connection or settings', () => {
    expect(hostMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: {
        theme: readyPayload.theme,
        locale: readyPayload.locale,
        directory: readyPayload.directory,
        session: readyPayload.session,
        surface: readyPayload.surface,
      },
    }).success).toBe(false);
  });

  test('resolves a failed result code and falls back to HOST_REJECTED', () => {
    expect(parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: false,
      error: 'Not connected.',
      code: 'DISCONNECTED',
    })).toMatchObject({
      type: 'result',
      ok: false,
      error: 'Not connected.',
      code: 'DISCONNECTED',
    });
    expect(parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: false,
      error: 'Request failed.',
    })).toMatchObject({
      type: 'result',
      ok: false,
      code: 'HOST_REJECTED',
    });
    expect(parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: false,
      error: 'Nope',
      code: 'NOT_A_CODE',
    })).toMatchObject({
      type: 'result',
      ok: false,
      code: 'HOST_REJECTED',
    });
  });

  test('defaults missing session busy to false and keeps model and agent', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session',
      payload: {
        session: {
          id: 'ses-1',
          title: 'Hello',
          model: 'anthropic/claude',
          agent: 'build',
        },
      },
    });
    expect(message).toMatchObject({
      type: 'session',
      payload: {
        session: {
          id: 'ses-1',
          title: 'Hello',
          busy: false,
          model: 'anthropic/claude',
          agent: 'build',
        },
      },
    });
  });

  test('accepts a session-lifecycle push', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session-lifecycle',
      payload: { sessionId: 'ses-1', phase: 'started' },
    });
    expect(message).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session-lifecycle',
      payload: { sessionId: 'ses-1', phase: 'started' },
    });
  });

  test('accepts a start-session result payload', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: true,
      payload: { sessionId: 'ses-9', sent: 'no-model' },
    });
    expect(message).toMatchObject({
      type: 'result',
      ok: true,
      payload: { sessionId: 'ses-9', sent: 'no-model' },
    });
  });

  test('accepts a prompt result payload', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: true,
      payload: { sent: 'sent' },
    });
    expect(message).toMatchObject({
      type: 'result',
      ok: true,
      payload: { sent: 'sent' },
    });
  });

  test('accepts a request result payload', () => {
    const message = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: true,
      payload: { status: 200, body: '{"ok":true}' },
    });
    expect(message).toMatchObject({
      type: 'result',
      ok: true,
      payload: { status: 200, body: '{"ok":true}' },
    });
  });

  test('accepts the four file result payloads', () => {
    const result = (payload: unknown) => parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: true,
      // Untrusted wire value on purpose.
      payload: payload as { status: number; body: string },
    });
    expect(result({ content: 'hello' })).toMatchObject({ ok: true, payload: { content: 'hello' } });
    expect(result({ written: true })).toMatchObject({ ok: true, payload: { written: true } });
    expect(result({ entries: [{ name: 'a', kind: 'file' }, { name: 'b', kind: 'directory' }] })).toMatchObject({
      ok: true,
      payload: { entries: [{ name: 'a', kind: 'file' }, { name: 'b', kind: 'directory' }] },
    });
    expect(result({ kind: 'missing', size: 0, mtime: 0 })).toMatchObject({ ok: true, payload: { kind: 'missing', size: 0, mtime: 0 } });
    expect(result({ written: false })).toBeNull();
    expect(result({ entries: [{ name: 'a', kind: 'symlink' }] })).toBeNull();
  });

  test('drops ready without a session field', () => {
    expect(hostMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'ready',
      payload: {
        theme: readyPayload.theme,
        locale: readyPayload.locale,
        directory: readyPayload.directory,
      },
    }).success).toBe(false);
  });

  test('drops a result without an id', () => {
    expect(hostMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      ok: true,
    }).success).toBe(false);
  });
});

describe('parseGuestMessage', () => {
  test('accepts hello without an id', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'hello',
    })).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'hello',
    });
  });

  test('accepts toast', () => {
    const message = parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'toast',
      id: 'oc-1',
      payload: { kind: 'info', message: 'Hello' },
    });
    expect(message).toMatchObject({ type: 'toast', id: 'oc-1' });
  });

  test('drops toast with an empty message', () => {
    expect(guestMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'toast',
      id: 'oc-1',
      payload: { kind: 'info', message: '   ' },
    }).success).toBe(false);
  });

  test('accepts clipboard-write and compose', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'clipboard-write',
      id: 'oc-2',
      payload: { text: '/repo' },
    })?.type).toBe('clipboard-write');
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'compose',
      id: 'oc-3',
      payload: { text: 'Ask about the diff', mode: 'append' },
    })?.type).toBe('compose');
  });

  test('accepts attach and close', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-7',
      payload: {
        providerId: 'hello',
        id: 'HELLO-1',
        title: 'Sample ticket',
        url: 'https://example.com/HELLO-1',
      },
    })?.type).toBe('attach');
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'close',
      id: 'oc-8',
    })?.type).toBe('close');
  });

  test('clamps an attach title the host schema would drop', () => {
    const title = 'x'.repeat(GUEST_ATTACH_TITLE_MAX + 40);
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-7',
      payload: {
        providerId: 'clickup',
        id: 'abc',
        title,
        url: 'https://app.clickup.com/t/abc',
      },
    })).toBeNull();
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-7',
      payload: clampAttachRequest({
        providerId: 'clickup',
        id: 'abc',
        title,
        url: 'https://app.clickup.com/t/abc',
      }),
    })?.type).toBe('attach');
  });

  test('keeps attach data within the limit and drops it over the limit', () => {
    const base = { providerId: 'tasks-demo', id: 'DEMO-1', title: 'T', url: 'https://x.test/1' };
    const data = { status: 'open', comments: [{ author: 'mara', text: 'hi' }] };
    expect(clampAttachRequest({ ...base, data })).toEqual({ ...base, kind: 'issue', data });
    expect(clampAttachRequest({ ...base, data: 'x'.repeat(GUEST_ATTACH_DATA_MAX) })).toEqual({ ...base, kind: 'issue' });
    expect(clampStartSessionRequest({ ...base, data: null, worktree: true })).toEqual({ ...base, kind: 'issue', data: null, worktree: true });
  });

  test('keeps pull author and branches and drops branches on an issue', () => {
    expect(clampAttachRequest({
      providerId: 'gitlab',
      id: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      kind: 'pull',
      author: 'ada',
      branches: { head: 'feature', base: 'main' },
    })).toEqual({
      providerId: 'gitlab',
      id: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      kind: 'pull',
      author: 'ada',
      branches: { head: 'feature', base: 'main' },
    });
    expect(clampAttachRequest({
      providerId: 'gitlab',
      id: '12',
      title: 'Login is broken',
      url: 'https://gitlab.com/acme/app/-/issues/12',
      kind: 'issue',
      author: 'ada',
      branches: { head: 'feature', base: 'main' },
    })).toEqual({
      providerId: 'gitlab',
      id: '12',
      title: 'Login is broken',
      url: 'https://gitlab.com/acme/app/-/issues/12',
      kind: 'issue',
      author: 'ada',
    });
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-7',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'https://gitlab.com/acme/app/-/merge_requests/12',
        kind: 'pull',
        author: 'ada',
        branches: { head: 'feature', base: 'main' },
      },
    })?.type).toBe('attach');
  });

  test('accepts start-session and keeps worktree only when asked', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'start-session',
      id: 'oc-12',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'https://gitlab.com/acme/app/-/merge_requests/12',
        kind: 'pull',
        worktree: true,
      },
    })?.type).toBe('start-session');
    expect(clampStartSessionRequest({
      providerId: 'gitlab',
      id: '!12',
      title: 'Fix login',
      url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      kind: 'pull',
      worktree: true,
    }).worktree).toBe(true);
    expect(clampStartSessionRequest({
      providerId: 'gitlab',
      id: '12',
      title: 'Login',
      url: 'https://gitlab.com/acme/app/-/issues/12',
      worktree: false,
    }).worktree).toBeUndefined();
  });

  test('accepts prompt and session-link', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'prompt',
      id: 'oc-20',
      payload: { text: 'Fix the login', send: true },
    })?.type).toBe('prompt');
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session-link',
      id: 'oc-21',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      },
    })?.type).toBe('session-link');
    expect(clampPromptRequest({
      text: `  ${'x'.repeat(GUEST_COMPOSE_TEXT_MAX + 20)}  `,
      send: false,
    })).toEqual({
      text: 'x'.repeat(GUEST_COMPOSE_TEXT_MAX),
    });
    expect(clampPromptRequest({ text: 'Send this', send: true }).send).toBe(true);
  });

  test('drops attach without an http url shape the host will accept later', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-7',
      payload: {
        providerId: 'Hello',
        id: 'HELLO-1',
        title: 'Sample ticket',
        url: 'https://example.com/HELLO-1',
      },
    })).toBeNull();
  });

  test('accepts oauth-start, oauth-disconnect, and request', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'oauth-start',
      id: 'oc-10',
    })?.type).toBe('oauth-start');
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'oauth-disconnect',
      id: 'oc-11',
    })?.type).toBe('oauth-disconnect');
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'request',
      id: 'oc-12',
      payload: { method: 'GET', path: '/api/v2/user' },
    })?.type).toBe('request');
  });

  test('accepts file messages and drops an empty or backslash path', () => {
    const base = { channel: OPENCHAMBER_SDK_CHANNEL, v: 1 as const, id: 'oc-20' };
    expect(parseGuestMessage({ ...base, type: 'file-read', payload: { path: 'README.md' } })?.type).toBe('file-read');
    expect(parseGuestMessage({ ...base, type: 'file-write', payload: { path: '~/.config/x.json', content: '{}' } })?.type).toBe('file-write');
    expect(parseGuestMessage({ ...base, type: 'file-list', payload: { path: '.' } })?.type).toBe('file-list');
    expect(parseGuestMessage({ ...base, type: 'file-stat', payload: { path: '/tmp/x' } })?.type).toBe('file-stat');
    expect(parseGuestMessage({ ...base, type: 'file-read', payload: { path: '' } })).toBeNull();
    expect(parseGuestMessage({ ...base, type: 'file-read', payload: { path: 'a\\b' } })).toBeNull();
    expect(parseGuestMessage({ ...base, type: 'file-write', payload: { path: 'a' } })).toBeNull();
  });

  test('drops a request path that escapes the api origin', () => {
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'request',
      id: 'oc-12',
      payload: { method: 'GET', path: '/api/../secret' },
    })).toBeNull();
    expect(parseGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'request',
      id: 'oc-12',
      payload: { method: 'GET', path: 'https://evil.example/x' },
    })).toBeNull();
  });

  test('drops empty compose text', () => {
    expect(guestMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'compose',
      id: 'oc-3',
      payload: { text: '   ' },
    }).success).toBe(false);
  });

  test('drops compose text over the cap', () => {
    expect(guestMessageSchema.safeParse({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'compose',
      id: 'oc-3',
      payload: { text: 'x'.repeat(GUEST_COMPOSE_TEXT_MAX + 1) },
    }).success).toBe(false);
  });
});

describe('readHostMessage', () => {
  test('accepts a host push and a result on the envelope alone', () => {
    const ready = parseHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'directory',
      payload: { directory: '/repo' },
    });
    expect(readHostMessage(ready)).toEqual(ready);
    const failed = readHostMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: 'oc-1',
      ok: false,
      error: 'nope',
      code: 'made-up',
    });
    expect(failed).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: 'oc-1',
      ok: false,
      error: 'nope',
      code: 'HOST_REJECTED',
    });
  });

  test('drops junk, wrong channels, and results without an id or error', () => {
    expect(readHostMessage(null)).toBeNull();
    expect(readHostMessage('hello')).toBeNull();
    expect(readHostMessage({ channel: 'other', v: 1, type: 'directory', payload: {} })).toBeNull();
    expect(readHostMessage({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'nope', payload: {} })).toBeNull();
    expect(readHostMessage({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'result', ok: true })).toBeNull();
    expect(readHostMessage({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'result', id: 'x', ok: false })).toBeNull();
  });
});

describe('actions, commands, and badge wire shapes', () => {
  const envelope = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION };
  const messageItem = {
    kind: 'message',
    action: 'create-task',
    sessionId: 'ses-1',
    sessionTitle: 'Hello',
    directory: '/repo',
    messageId: 'msg-1',
    role: 'assistant',
    text: 'Do the thing.',
  } as const;
  const sessionItem = {
    kind: 'session',
    action: 'summarize',
    sessionId: 'ses-1',
    sessionTitle: 'Hello',
    directory: '/repo',
    messages: [{ id: 'msg-1', role: 'user', text: 'Hi', createdAt: 1 }],
    truncated: false,
  } as const;

  test('accepts message and session items on ready and item pushes', () => {
    for (const item of [messageItem, sessionItem]) {
      expect(parseHostMessage({ ...envelope, type: 'ready', payload: { ...readyPayload, item } })).toMatchObject({ type: 'ready', payload: { item } });
      expect(parseHostMessage({ ...envelope, type: 'item', payload: { item } })).toMatchObject({ payload: { item } });
    }
    expect(parseHostMessage({ ...envelope, type: 'item', payload: { item: { ...sessionItem, messages: undefined } } })).not.toBeNull();
  });

  test('drops a message item over the text cap and an item with an unknown kind', () => {
    expect(parseHostMessage({ ...envelope, type: 'item', payload: { item: { ...messageItem, text: 'x'.repeat(200_001) } } })).toBeNull();
    // Junk on purpose: a kind the contract does not know.
    expect(parseHostMessage({ ...envelope, type: 'item', payload: { item: { ...messageItem, kind: 'thread' } as unknown as typeof messageItem } })).toBeNull();
    expect(parseHostMessage({ ...envelope, type: 'item', payload: { item: { ...messageItem, role: 'system' } as unknown as typeof messageItem } })).toBeNull();
  });

  test('accepts resolve and both resolve-result shapes', () => {
    expect(parseHostMessage({ ...envelope, type: 'resolve', id: 'r-1', payload: { command: 'task', args: '' } }))
      .toEqual({ ...envelope, type: 'resolve', id: 'r-1', payload: { command: 'task', args: '' } });
    expect(readHostMessage({ ...envelope, type: 'resolve', id: 'r-1', payload: { command: 'task', args: 'x' } }))
      .toMatchObject({ type: 'resolve', id: 'r-1' });
    expect(parseGuestMessage({ ...envelope, type: 'resolve-result', id: 'r-1', payload: { item: null } }))
      .toEqual({ ...envelope, type: 'resolve-result', id: 'r-1', payload: { item: null } });
    expect(parseGuestMessage({
      ...envelope,
      type: 'resolve-result',
      id: 'r-1',
      payload: { item: { providerId: 'tasks-demo', id: 'DEMO-1', title: 'T', url: 'https://example.com/1' } },
    })).toMatchObject({ payload: { item: { id: 'DEMO-1' } } });
    expect(parseGuestMessage({ ...envelope, type: 'resolve-result', id: 'r-1', payload: { error: 'nope' } }))
      .toMatchObject({ payload: { error: 'nope' } });
    expect(parseGuestMessage({ ...envelope, type: 'resolve-result', id: 'r-1', payload: { error: '' } })).toBeNull();
  });

  test('accepts badge counts in range and drops the rest', () => {
    expect(parseGuestMessage({ ...envelope, type: 'badge', id: 'b-1', payload: { count: 4 } })).toMatchObject({ payload: { count: 4 } });
    expect(parseGuestMessage({ ...envelope, type: 'badge', id: 'b-1', payload: { count: null } })).toMatchObject({ payload: { count: null } });
    expect(parseGuestMessage({ ...envelope, type: 'badge', id: 'b-1', payload: { count: 1000 } })).toBeNull();
    expect(parseGuestMessage({ ...envelope, type: 'badge', id: 'b-1', payload: { count: -1 } })).toBeNull();
    expect(parseGuestMessage({ ...envelope, type: 'badge', id: 'b-1', payload: { count: 1.5 } })).toBeNull();
  });
});
