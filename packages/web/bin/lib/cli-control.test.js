import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestControlAction, resolveControlTimeoutMs } from './cli-control.js';
import { requestJson } from './cli-http.js';

vi.mock('./cli-http.js', () => ({ requestJson: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe('requestControlAction', () => {
  it('shows the retained worktree and a retry command without claiming a session exists', async () => {
    const directory = "/fixture/someone's worktree";
    vi.mocked(requestJson).mockResolvedValueOnce({
      response: { ok: false, status: 503 },
      body: { error: 'Session selection is not ready', partial: true, partialAction: 'worktree-created', directory },
    });
    const error = await requestControlAction(3000, 'session.create', {
      worktree: { name: 'task' }, prompt: 'Review this', agent: 'plan', model: 'example/model', variant: 'high',
    }).catch((error) => error);
    expect(error.message).toContain(`A worktree remains at ${directory}.`);
    expect(error.message).toContain(`openchamber session create --directory '/fixture/someone'"'"'s worktree'`);
    expect(error.message).toContain(`--port 3000 --prompt 'Review this' --model example/model --agent plan --variant high`);
    expect(error.message).toContain('without --worktree');
    expect(error.message).not.toMatch(/(?:Created|Forked) session/);
  });

  it('quotes apostrophes in the recovery command for Windows PowerShell', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(requestJson).mockResolvedValueOnce({
      response: { ok: false, status: 503 },
      body: { error: 'Not ready', partial: true, partialAction: 'worktree-created', directory: "C:/someone's checkout" },
    });
    const error = await requestControlAction(3000, 'session.create', { prompt: "Review someone's code" }).catch((error) => error);
    expect(error.message).toContain("--directory 'C:/someone''s checkout'");
    expect(error.message).toContain("--prompt 'Review someone''s code'");
    expect(error.message).not.toContain(`'"'"'`);
  });

  it('keeps an existing-checkout retry alive through bootstrap and discovery', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({ response: { ok: true }, body: { sessionId: 'ses_retry' } });
    await requestControlAction(3000, 'session.create', { directory: '/fixture/checkout/ai', prompt: 'Review this' });
    expect(requestJson).toHaveBeenLastCalledWith(3000, '/api/openchamber/control', expect.objectContaining({ timeoutMs: 120_000 }));
  });
});

describe('resolveControlTimeoutMs', () => {
  it('keeps the short default HTTP timeout for instant control calls', () => {
    expect(resolveControlTimeoutMs({}, {})).toBeUndefined();
    expect(resolveControlTimeoutMs({ wait: false, timeout: 30 }, {})).toBeUndefined();
  });

  it('outlives the default server wait window when wait is set', () => {
    expect(resolveControlTimeoutMs({ wait: true }, {})).toBe(630_000);
  });

  it('derives the HTTP timeout from an explicit wait timeout in seconds', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, {})).toBe(60_000);
  });

  it('never shrinks an explicitly requested HTTP timeout', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, { timeoutMs: 5000 })).toBe(5000);
  });

  it('allows a worktree to be provisioned without waiting for the session', () => {
    expect(resolveControlTimeoutMs({ worktree: 'feature' }, {})).toBe(120_000);
  });

  it('ignores a blank worktree name', () => {
    expect(resolveControlTimeoutMs({ worktree: '   ' }, {})).toBeUndefined();
  });

  it('covers bootstrap before a session wait in an existing checkout', () => {
    expect(resolveControlTimeoutMs({ directory: '/fixture/checkout', wait: true, timeout: 30 }, {}, 'session.create')).toBe(180_000);
    expect(resolveControlTimeoutMs({ projectId: 'project' }, {}, 'session.create')).toBe(120_000);
    expect(resolveControlTimeoutMs({ directory: '/fixture/checkout' }, {}, 'session.status')).toBeUndefined();
  });

  it('covers provisioning and waiting in sequence when both are requested', () => {
    // The server creates the worktree before it begins waiting for the session,
    // so the client window must span both rather than the longer of the two.
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30, worktree: 'feature' }, {})).toBe(180_000);
    expect(resolveControlTimeoutMs({ wait: true, worktree: 'feature' }, {})).toBe(750_000);
  });
});
