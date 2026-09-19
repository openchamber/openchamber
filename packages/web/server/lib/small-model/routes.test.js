import { describe, expect, it, vi } from 'vitest';

import { registerSmallModelRoutes } from './routes.js';

// Direct unit harness over the route handlers: no express body parsing to
// attach, so the request body is passed in as the route would receive it.
const createHarness = () => {
  const generateSmallModelText = vi.fn();
  const app = {
    post: (path, handler) => { app.postHandler = handler; },
    get: (path, handler) => { app.getHandler = handler; },
  };
  registerSmallModelRoutes(app, {
    getSmallModelService: async () => ({ generateSmallModelText }),
  });

  const call = async (body, serviceResult = { text: 'generated' }) => {
    generateSmallModelText.mockReset();
    if (serviceResult instanceof Error) {
      generateSmallModelText.mockRejectedValue(serviceResult);
    } else {
      generateSmallModelText.mockResolvedValue(serviceResult);
    }
    const response = {
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await app.postHandler({ body }, response);
    return {
      sent: generateSmallModelText.mock.calls[0]?.[0],
      statusCode: response.statusCode,
      body: response.body,
    };
  };

  return { generateSmallModelText, call };
};

describe('POST /api/small-model/generate — onOverflow', () => {
  it('passes a valid onOverflow through to the service', async () => {
    const { call } = createHarness();
    const { sent } = await call({ prompt: 'hi', onOverflow: 'error' });
    expect(sent.onOverflow).toBe('error');
  });

  it('falls back to the default truncate for an invalid value', async () => {
    const { call } = createHarness();
    const { sent } = await call({ prompt: 'hi', onOverflow: 'explode' });
    expect(sent.onOverflow).toBe('truncate');
  });

  it('defaults to truncate when onOverflow is absent', async () => {
    const { call } = createHarness();
    const { sent } = await call({ prompt: 'hi' });
    expect(sent.onOverflow).toBe('truncate');
  });

  it('passes the backend 413 message through so the client sees required/available chars', async () => {
    const { call } = createHarness();
    const failure = Object.assign(
      new Error('Input is too large for anthropic/claude-haiku-4-5: 20000 characters exceeds the 16000 the model\'s context allows'),
      { statusCode: 413, code: 'context-too-small' },
    );
    const { statusCode, body } = await call({ prompt: 'x', onOverflow: 'error' }, failure);
    expect(statusCode).toBe(413);
    expect(body.code).toBe('context-too-small');
    expect(body.error).toContain('20000');
  });

  it('replaces other backend failures with the generic guidance copy', async () => {
    const { call } = createHarness();
    const failure = Object.assign(new Error('provider exploded'), { statusCode: 502 });
    const { statusCode, body } = await call({ prompt: 'x' }, failure);
    expect(statusCode).toBe(502);
    expect(body.error).not.toContain('provider');
    expect(body.error).toContain('Settings');
  });

  it('still passes the 404 message through verbatim', async () => {
    const { call } = createHarness();
    const failure = Object.assign(new Error('No small model available — no authenticated provider has a suitable model'), { statusCode: 404 });
    const { statusCode, body } = await call({ prompt: 'x' }, failure);
    expect(statusCode).toBe(404);
    expect(body.error).toContain('No small model available');
  });
});
