import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { createRenderPageAction, createPageAnswers } from './render-page.js';
import { createOpenChamberControlService } from './service.js';
import { inspectLocalImage } from '../markdown-image-grants/inspect-image.js';

describe('control boundary compatibility', () => {
  it('keeps missing message timestamps as null', async () => {
    const service = createOpenChamberControlService({
      buildOpenCodeUrl: () => 'http://localhost:4096/api/info',
      getOpenCodeAuthHeaders: () => ({}),
      createClient: () => ({
        session: {
          get: async () => ({ id: 'ses_1', location: { directory: '/repo' } }),
          active: async () => ({}),
        },
        message: {
          list: async () => ({ data: [{ id: 'msg_1', type: 'assistant', content: [{ type: 'text', text: 'Hello' }] }] }),
        },
      }),
    });
    const result = await service.execute('session.messages', { sessionId: 'ses_1' }, '/repo');
    expect(result.messages).toEqual([{
      id: 'msg_1', role: 'assistant', createdAt: null, completedAt: null, model: null, text: 'Hello',
    }]);
  });

  it('passes unchecked form values through the published client to the HTTP body', async () => {
    let body;
    const service = createOpenChamberControlService({
      buildOpenCodeUrl: () => 'http://localhost:4096/api/info',
      getOpenCodeAuthHeaders: () => ({}),
      createClient: (options) => OpenCode.make({
        ...options,
        fetch: async (url, init) => {
          if (url.pathname.endsWith('/reply')) {
            body = JSON.parse(init.body);
            return new Response(null, { status: 204 });
          }
          const data = url.pathname.endsWith('/form/frm_1')
            ? { data: { fields: [{ key: 'external', type: 'external' }] } }
            : { data: { id: 'ses_1', location: { directory: '/repo' } } };
          return Response.json(data);
        },
      }),
    });
    await service.answerForm({
      sessionID: 'ses_1',
      formID: 'frm_1',
      answer: { external: { unchecked: true } },
    });
    expect(body).toEqual({ answer: { external: { unchecked: true } } });
  });

  it.each([null, undefined])('keeps an absent image directory %s distinct from an empty one', async (directory) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-control-image-boundary-'));
    try {
      const source = path.join(root, 'image.png');
      await fs.writeFile(source, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      await expect(inspectLocalImage({ source, directory, fsPromises: fs, path }))
        .rejects.toBeInstanceOf(TypeError);
      const render = createRenderPageAction({
        isEnabled: async () => true,
        pageAnswers: createPageAnswers(),
        hasUnreadChat: async () => false,
      });
      const input = { html: `<img src="${source}">` };
      await expect(render(input, { directory })).resolves.toMatchObject({
        images: { shown: 0, notShown: [{ src: source, reason: 'not a readable PNG, JPEG, GIF or WebP of at most 10 MB' }] },
      });
      const shown = await render(input, { directory: '' });
      expect(shown).not.toHaveProperty('images');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
