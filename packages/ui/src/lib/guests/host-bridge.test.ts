import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_CHANNEL, type GuestMessage, type GuestRequest } from '@openchamber/sdk';

import {
  answerGuestMessage,
  guestSessionLifecyclePhase,
  guestSessionModelId,
  toGuestSessionSnapshot,
} from './host-bridge.ts';

const toast: GuestMessage = {
  channel: OPENCHAMBER_SDK_CHANNEL,
  v: 1,
  type: 'toast',
  id: 'oc-1',
  payload: { kind: 'info', message: 'Hello' },
};

const effects = (overrides: {
  toast?: (kind: 'info' | 'success' | 'error', message: string) => void;
  openUrl?: () => Promise<boolean>;
  openSurface?: () => void;
  writeClipboard?: (text: string) => Promise<boolean>;
  compose?: (text: string, mode: 'replace' | 'append') => void;
  attach?: (issue: { providerId: string; id: string; title: string; url: string; kind?: string; author?: string }) => void;
  startSession?: (request: { providerId: string; id: string; title: string; url: string; worktree?: boolean }) => Promise<
    { sessionId: string; sent: 'sent' | 'no-model' | 'skipped' | 'failed' } | null
  >;
  prompt?: (request: { text: string; send?: boolean }) => Promise<
    | { ok: true; result: { sent: 'sent' | 'no-model' | 'skipped' | 'failed' } }
    | { ok: false; code: 'HOST_REJECTED' | 'NO_SESSION' | 'SESSION_BUSY'; message: string }
  >;
  sessionLink?: (issue: { providerId: string; id: string; title: string; url: string }) => Promise<
    | { ok: true }
    | { ok: false; code: 'HOST_REJECTED' | 'NO_SESSION'; message: string }
  >;
  close?: () => void;
  oauthStart?: () => Promise<boolean>;
  oauthDisconnect?: () => Promise<boolean>;
  request?: (request: GuestRequest) => Promise<
    | { ok: true; result: { status: number; body: string } }
    | { ok: false; code: 'HOST_REJECTED' | 'DISCONNECTED' | 'BAD_PATH' | 'NO_INTEGRATION'; message: string }
  >;
  agentRequest?: (request: GuestRequest) => Promise<
    | { ok: true; result: { status: number; body: string } }
    | { ok: false; code: 'HOST_REJECTED' | 'NO_AGENT' | 'AGENT_FAILED' | 'BAD_PATH'; message: string }
  >;
  agentStatus?: () => Promise<
    | { ok: true; result: { status: 'stopped' | 'starting' | 'ready' | 'failed' } }
    | { ok: false; code: 'HOST_REJECTED' | 'NO_AGENT'; message: string }
  >;
} = {}) => ({
  toast: overrides.toast ?? (() => {}),
  openUrl: overrides.openUrl ?? (async () => true),
  openSurface: overrides.openSurface ?? (() => {}),
  writeClipboard: overrides.writeClipboard ?? (async () => true),
  compose: overrides.compose ?? (() => {}),
  attach: overrides.attach ?? (() => {}),
  startSession: overrides.startSession ?? (async () => ({ sessionId: 'ses-1', sent: 'skipped' })),
  prompt: overrides.prompt ?? (async () => ({ ok: true, result: { sent: 'skipped' } })),
  sessionLink: overrides.sessionLink ?? (async () => ({ ok: true })),
  close: overrides.close ?? (() => {}),
  oauthStart: overrides.oauthStart ?? (async () => true),
  oauthDisconnect: overrides.oauthDisconnect ?? (async () => true),
  request: overrides.request ?? (async () => ({ ok: true, result: { status: 200, body: '{}' } })),
  agentRequest: overrides.agentRequest ?? (async () => ({ ok: true, result: { status: 200, body: '{}' } })),
  agentStatus: overrides.agentStatus ?? (async () => ({ ok: true, result: { status: 'ready' as const } })),
});

describe('answerGuestMessage', () => {
  test('toasts and answers ok', async () => {
    const seen: string[] = [];
    const reply = await answerGuestMessage(toast, effects({
      toast: (_kind, message) => {
        seen.push(message);
      },
    }));
    expect(seen).toEqual(['Hello']);
    expect(reply).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-1',
      ok: true,
    });
  });

  test('rejects a non-http url', async () => {
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'open-url',
      id: 'oc-2',
      payload: { url: 'file:///etc/passwd' },
    }, effects());
    expect(reply?.type).toBe('result');
    expect(reply && reply.type === 'result' && reply.ok).toBe(false);
  });

  test('rejects an unknown surface', async () => {
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'open-surface',
      id: 'oc-3',
      payload: { surfaceId: 'not-a-surface' },
    }, effects());
    expect(reply?.type).toBe('result');
    expect(reply && reply.type === 'result' && reply.ok).toBe(false);
  });

  test('writes clipboard text', async () => {
    const seen: string[] = [];
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'clipboard-write',
      id: 'oc-4',
      payload: { text: '/repo' },
    }, effects({
      writeClipboard: async (text) => {
        seen.push(text);
        return true;
      },
    }));
    expect(seen).toEqual(['/repo']);
    expect(reply && reply.type === 'result' && reply.ok).toBe(true);
  });

  test('rejects a failed clipboard write', async () => {
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'clipboard-write',
      id: 'oc-5',
      payload: { text: '/repo' },
    }, effects({
      writeClipboard: async () => false,
    }));
    expect(reply && reply.type === 'result' && reply.ok).toBe(false);
  });

  test('composes with append when the guest omits mode', async () => {
    const seen: Array<{ text: string; mode: 'replace' | 'append' }> = [];
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'compose',
      id: 'oc-6',
      payload: { text: 'Ask about the diff' },
    }, effects({
      compose: (text, mode) => {
        seen.push({ text, mode });
      },
    }));
    expect(seen).toEqual([{ text: 'Ask about the diff', mode: 'append' }]);
    expect(reply && reply.type === 'result' && reply.ok).toBe(true);
  });

  test('attaches an http issue and rejects a file url', async () => {
    const seen: string[] = [];
    const ok = await answerGuestMessage({
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
    }, effects({
      attach: (issue) => {
        seen.push(issue.id);
      },
    }));
    expect(seen).toEqual(['HELLO-1']);
    expect(ok && ok.type === 'result' && ok.ok).toBe(true);

    const pulls: Array<{ kind?: string; author?: string }> = [];
    const pull = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-7b',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'https://gitlab.com/acme/app/-/merge_requests/12',
        kind: 'pull',
        author: 'ada',
        branches: { head: 'feature', base: 'main' },
      },
    }, effects({
      attach: (issue) => {
        pulls.push({ kind: issue.kind, author: issue.author });
      },
    }));
    expect(pulls).toEqual([{ kind: 'pull', author: 'ada' }]);
    expect(pull && pull.type === 'result' && pull.ok).toBe(true);

    const bad = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'attach',
      id: 'oc-8',
      payload: {
        providerId: 'hello',
        id: 'HELLO-1',
        title: 'Sample ticket',
        url: 'file:///tmp/secret',
      },
    }, effects());
    expect(bad && bad.type === 'result' && bad.ok).toBe(false);
  });

  test('starts a session and rejects a file url', async () => {
    const seen: Array<{ id: string; worktree?: boolean }> = [];
    const ok = await answerGuestMessage({
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
    }, effects({
      startSession: async (request) => {
        seen.push({ id: request.id, worktree: request.worktree });
        return { sessionId: 'ses-9', sent: 'sent' };
      },
    }));
    expect(seen).toEqual([{ id: '!12', worktree: true }]);
    expect(ok).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-12',
      ok: true,
      payload: { sessionId: 'ses-9', sent: 'sent' },
    });

    const bad = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'start-session',
      id: 'oc-13',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'file:///tmp/secret',
      },
    }, effects());
    expect(bad && bad.type === 'result' && bad.ok).toBe(false);
  });

  test('prompts and forwards a busy refusal', async () => {
    const seen: Array<{ text: string; send?: boolean }> = [];
    const ok = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'prompt',
      id: 'oc-14',
      payload: { text: 'Fix the login', send: true },
    }, effects({
      prompt: async (request) => {
        seen.push(request);
        return { ok: true, result: { sent: 'sent' } };
      },
    }));
    expect(seen).toEqual([{ text: 'Fix the login', send: true }]);
    expect(ok).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-14',
      ok: true,
      payload: { sent: 'sent' },
    });

    const busy = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'prompt',
      id: 'oc-15',
      payload: { text: 'Wait', send: true },
    }, effects({
      prompt: async () => ({ ok: false, code: 'SESSION_BUSY', message: 'Session is busy.' }),
    }));
    expect(busy).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-15',
      ok: false,
      error: 'Session is busy.',
      code: 'SESSION_BUSY',
    });
  });

  test('links the current session and rejects a file url', async () => {
    const seen: string[] = [];
    const ok = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session-link',
      id: 'oc-16',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      },
    }, effects({
      sessionLink: async (issue) => {
        seen.push(issue.id);
        return { ok: true };
      },
    }));
    expect(seen).toEqual(['!12']);
    expect(ok && ok.type === 'result' && ok.ok).toBe(true);

    const missing = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session-link',
      id: 'oc-17',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'https://gitlab.com/acme/app/-/merge_requests/12',
      },
    }, effects({
      sessionLink: async () => ({ ok: false, code: 'NO_SESSION', message: 'No open session.' }),
    }));
    expect(missing).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-17',
      ok: false,
      error: 'No open session.',
      code: 'NO_SESSION',
    });

    const bad = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'session-link',
      id: 'oc-18',
      payload: {
        providerId: 'gitlab',
        id: '!12',
        title: 'Fix login',
        url: 'file:///tmp/secret',
      },
    }, effects());
    expect(bad && bad.type === 'result' && bad.ok).toBe(false);
  });

  test('closes the host chrome', async () => {
    let closed = 0;
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'close',
      id: 'oc-9',
    }, effects({
      close: () => {
        closed += 1;
      },
    }));
    expect(closed).toBe(1);
    expect(reply && reply.type === 'result' && reply.ok).toBe(true);
  });

  test('starts oauth and answers ok', async () => {
    let started = 0;
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'oauth-start',
      id: 'oc-10',
    }, effects({
      oauthStart: async () => {
        started += 1;
        return true;
      },
    }));
    expect(started).toBe(1);
    expect(reply && reply.type === 'result' && reply.ok).toBe(true);
  });

  test('returns a request payload without a token', async () => {
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'request',
      id: 'oc-11',
      payload: { method: 'GET', path: '/api/v2/user' },
    }, effects({
      request: async () => ({ ok: true, result: { status: 200, body: '{"user":{"username":"ada"}}' } }),
    }));
    expect(reply).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-11',
      ok: true,
      payload: { status: 200, body: '{"user":{"username":"ada"}}' },
    });
    expect(JSON.stringify(reply)).not.toContain('Bearer');
  });

  test('forwards a disconnected request code', async () => {
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'request',
      id: 'oc-11',
      payload: { method: 'GET', path: '/api/v2/user' },
    }, effects({
      request: async () => ({ ok: false, code: 'DISCONNECTED', message: 'Not connected.' }),
    }));
    expect(reply).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-11',
      ok: false,
      error: 'Not connected.',
      code: 'DISCONNECTED',
    });
  });

  test('proxies agentRequest and agentStatus', async () => {
    const agent = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'agent-request',
      id: 'oc-12',
      payload: { method: 'GET', path: '/containers' },
    }, effects({
      agentRequest: async () => ({ ok: true, result: { status: 200, body: '[]' } }),
    }));
    expect(agent).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-12',
      ok: true,
      payload: { status: 200, body: '[]' },
    });

    const status = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'agent-status',
      id: 'oc-13',
    }, effects({
      agentStatus: async () => ({ ok: true, result: { status: 'ready' } }),
    }));
    expect(status).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-13',
      ok: true,
      payload: { status: 'ready' },
    });
  });

  test('forwards NO_AGENT from agentRequest', async () => {
    const reply = await answerGuestMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'agent-request',
      id: 'oc-14',
      payload: { method: 'GET', path: '/containers' },
    }, effects({
      agentRequest: async () => ({
        ok: false,
        code: 'NO_AGENT',
        message: 'Allow this extension\'s local agent in Settings → Extensions.',
      }),
    }));
    expect(reply).toEqual({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: 1,
      type: 'result',
      id: 'oc-14',
      ok: false,
      error: 'Allow this extension\'s local agent in Settings → Extensions.',
      code: 'NO_AGENT',
    });
  });
});

describe('toGuestSessionSnapshot', () => {
  test('uses the title when present and falls back to the id', () => {
    expect(toGuestSessionSnapshot({ id: 'ses-1', title: 'Hello' })).toEqual({
      id: 'ses-1',
      title: 'Hello',
      busy: false,
    });
    expect(toGuestSessionSnapshot({
      id: 'ses-1',
      title: '  ',
      busy: true,
      model: 'anthropic/claude',
      agent: 'build',
    })).toEqual({
      id: 'ses-1',
      title: 'ses-1',
      busy: true,
      model: 'anthropic/claude',
      agent: 'build',
    });
    expect(toGuestSessionSnapshot(null)).toBeNull();
  });

  test('joins provider and model id', () => {
    expect(guestSessionModelId({ providerID: 'anthropic', id: 'claude' })).toBe('anthropic/claude');
    expect(guestSessionModelId({ providerID: '  ', id: 'claude' })).toBe(undefined);
    expect(guestSessionModelId(undefined)).toBe(undefined);
  });
});

describe('guestSessionLifecyclePhase', () => {
  test('maps live status and treats unknown as failure', () => {
    expect(guestSessionLifecyclePhase({ type: 'busy' })).toBe('started');
    expect(guestSessionLifecyclePhase({ type: 'retry' })).toBe('started');
    expect(guestSessionLifecyclePhase({ type: 'idle' })).toBe('completed');
    expect(guestSessionLifecyclePhase({ type: 'error' })).toBe('failure');
    expect(guestSessionLifecyclePhase({})).toBeNull();
    expect(guestSessionLifecyclePhase(null)).toBeNull();
  });
});
