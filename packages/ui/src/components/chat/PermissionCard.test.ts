import { describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { PermissionRequest, PermissionResponse } from '@/types/permission';

import { getVisiblePermissionPatterns } from './permissionCardPatterns';
import { permissionFilePreviewsSchema } from './permissionFilePreviews';

describe('permission file previews', () => {
  test('reads edit and new-file patches from OpenCode FileDiff.Info entries', () => {
    const files = [
      { file: '/repo/existing.ts', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, status: 'modified' },
      { file: '/repo/new.ts', patch: '@@ -0,0 +1 @@\n+created', additions: 1, deletions: 0, status: 'added' },
    ];
    expect(permissionFilePreviewsSchema.parse(files)).toEqual(files.map(({ file, patch }) => ({ file, patch })));
  });

  test('keeps valid files when another entry is malformed', () => {
    const valid = { file: '/repo/a.ts', patch: '@@ -0,0 +1 @@\n+ok' };
    expect(permissionFilePreviewsSchema.parse([null, { file: 'bad', patch: 42 }, valid, { file: 'empty', patch: '' }])).toEqual([valid]);
  });

  test('leaves legacy metadata and invalid lists to the existing preview path', () => {
    expect(permissionFilePreviewsSchema.parse(undefined)).toEqual([]);
    expect(permissionFilePreviewsSchema.parse({ diff: 'legacy' })).toEqual([]);
    expect(permissionFilePreviewsSchema.parse([])).toEqual([]);
  });
});

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'permission-card-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

describe('getVisiblePermissionPatterns', () => {
  test('omits a pattern already rendered as the bash command', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns([command], command)).toEqual([]);
  });

  test('preserves distinct permission patterns', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns(['bunx eslint *', command], command)).toEqual(['bunx eslint *']);
  });
});

const request = (id: string, always: string[] = []): PermissionRequest => ({
  id, sessionID: 'permission-card-test-session', permission: 'custom_tool',
  patterns: ['visible-pattern'], metadata: {}, always,
});

async function withPermissionCards(run: (fixture: {
  render: (...permissions: PermissionRequest[]) => Promise<void>;
  buttons: () => HTMLButtonElement[];
  click: (label: string) => Promise<void>;
  shortcut: (key: string, shiftKey?: boolean) => Promise<void>;
  replies: Array<{ path: string; body: string }>;
  responses: Array<{ id: string; response: PermissionResponse }>;
  holdReplies: () => void;
  finishReplies: () => Promise<void>;
}) => Promise<void>) {
  const dom = new Window({ url: 'http://permission-card.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replies: Array<{ path: string; body: string }> = [];
  const responses: Array<{ id: string; response: PermissionResponse }> = [];
  const completions: Array<() => void> = [];
  let holding = false;
  // Both SDK traffic and unrelated provider hydration stop at this boundary.
  // No original fetch is called; unrelated bootstrap reads stay pending.
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const outgoing = input instanceof Request ? input : new Request(input, init);
    const path = new URL(outgoing.url).pathname;
    if (outgoing.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(path)) {
      replies.push({ path, body: await outgoing.text() });
      if (holding) await new Promise<void>((resolve) => completions.push(resolve));
      return Response.json(true);
    }
    return new Promise<Response>(() => {});
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
    localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    fetch: Object.assign(transport, globalThis.fetch),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    const { createRoot } = await import('react-dom/client');
    const { SyncProvider } = await import('@/sync/sync-context');
    const { I18nProvider } = await import('@/lib/i18n');
    const { useConfigStore } = await import('@/stores/useConfigStore');
    const { PermissionCard } = await import('./PermissionCard');
    const config = useConfigStore.getState();
    const connection = {
      isConnected: config.isConnected, hasEverConnected: config.hasEverConnected,
      connectionPhase: config.connectionPhase, lastDisconnectReason: config.lastDisconnectReason,
      settingsMessageStreamTransport: config.settingsMessageStreamTransport,
    };
    // SSE uses the supplied SDK transport; auto mode could open a real socket.
    useConfigStore.setState({ settingsMessageStreamTransport: 'sse', isConnected: true });
    const sdk = createOpencodeClient({ baseUrl: 'http://permission-card.test', fetch: transport });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const buttons = () => Array.from(container.querySelectorAll('button'));
    const finishReplies = async () => {
      holding = false;
      await act(async () => { for (const complete of completions.splice(0)) complete(); });
    };
    try {
      await run({
        render: async (...permissions) => {
          await act(async () => root.render(React.createElement(SyncProvider, {
            sdk, directory: '/permission-card-test', children: React.createElement(I18nProvider, {
              children: permissions.map((permission) => React.createElement(PermissionCard, {
                key: permission.id, permission,
                onResponse: (response) => responses.push({ id: permission.id, response }),
              })),
            }),
          })));
        },
        buttons,
        click: async (label) => {
          const button = buttons().find((candidate) => candidate.textContent?.includes(label));
          if (!button) throw new Error(`Missing permission action: ${label}`);
          expect(button.disabled).toBe(false);
          await act(async () => button.click());
        },
        shortcut: async (key, shiftKey = false) => {
          await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', {
              key, altKey: true, shiftKey, bubbles: true, cancelable: true,
            }));
          });
        },
        replies, responses, holdReplies: () => { holding = true; }, finishReplies,
      });
    } finally {
      await finishReplies();
      await act(async () => root.unmount());
      container.remove();
      useConfigStore.setState(connection);
    }
  } finally {
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

const reply = (id: string, response: PermissionResponse) => ({
  path: `/permission/${id}/reply`, body: JSON.stringify({ reply: response }),
});

describe('PermissionCard responses', () => {
  test('empty always has no actionable persistent approval, even with metadata patterns', async () => {
    await withPermissionCards(async ({ render, buttons, replies }) => {
      const permission = request('empty');
      permission.metadata = { always: ['metadata-pattern'] };
      await render(permission);
      const persistent = buttons().filter((button) => button.textContent?.includes('Always'));
      expect(persistent.every((button) => button.disabled)).toBe(true);
      await act(async () => { for (const button of persistent) button.click(); });
      expect(replies).toEqual([]);
    });
  });

  test('empty always ignores Alt+Shift+Enter without responding or hiding the card', async () => {
    await withPermissionCards(async ({ render, shortcut, replies, responses, buttons }) => {
      await render(request('empty'));
      await shortcut('Enter', true);
      expect(replies).toEqual([]);
      expect(responses).toEqual([]);
      expect(buttons().some((button) => button.textContent?.includes('Allow Once'))).toBe(true);
    });
  });

  for (const input of ['button', 'shortcut']) {
    test(`nonempty always retains persistent approval by ${input}`, async () => {
      await withPermissionCards(async ({ render, click, shortcut, replies, responses, buttons }) => {
        await render(request('rememberable', ['remembered-pattern']));
        expect(buttons().some((button) => !button.disabled && button.textContent?.includes('Always'))).toBe(true);
        if (input === 'button') await click('Always');
        else await shortcut('Enter', true);
        expect(replies).toEqual([reply('rememberable', 'always')]);
        expect(responses).toEqual([{ id: 'rememberable', response: 'always' }]);
        expect(buttons()).toHaveLength(0);
        await shortcut('Enter', true);
        expect(replies).toHaveLength(1);
      });
    });

    for (const response of ['once', 'reject'] as const) {
      for (const always of [[], ['remembered-pattern']]) {
        test(`${response} by ${input} survives with ${always.length ? 'nonempty' : 'empty'} always`, async () => {
          await withPermissionCards(async ({ render, click, shortcut, replies, responses }) => {
            await render(request('ordinary', always));
            if (input === 'button') await click(response === 'once' ? 'Allow Once' : 'Deny');
            else await shortcut(response === 'once' ? 'Enter' : 'Backspace');
            expect(replies).toEqual([reply('ordinary', response)]);
            expect(responses).toEqual([{ id: 'ordinary', response }]);
          });
        });
      }
    }
  }

  test('newest pending card owns shortcuts until its response completes', async () => {
    await withPermissionCards(async ({ render, shortcut, replies, responses, buttons, holdReplies, finishReplies }) => {
      const older = request('older', ['remembered-pattern']);
      const newer = request('newer');
      await render(older);
      await render(older, newer);
      holdReplies();
      await shortcut('Enter');
      expect(replies).toEqual([reply('newer', 'once')]);
      expect(responses).toEqual([]);
      expect(buttons().filter((button) => button.textContent?.includes('Allow Once')).map((button) => button.disabled)).toEqual([false, true]);
      await finishReplies();
      expect(responses).toEqual([{ id: 'newer', response: 'once' }]);
      await shortcut('Enter', true);
      expect(replies).toEqual([reply('newer', 'once'), reply('older', 'always')]);
      expect(buttons()).toHaveLength(0);
      await shortcut('Backspace');
      expect(replies).toHaveLength(2);
    });
  });

  test('an empty newest card does not pass persistent approval to an older card', async () => {
    await withPermissionCards(async ({ render, shortcut, replies }) => {
      const older = request('older', ['remembered-pattern']);
      await render(older);
      await render(older, request('newer'));
      await shortcut('Enter', true);
      expect(replies).toEqual([]);
      await render(older);
      await shortcut('Enter', true);
      expect(replies).toEqual([reply('older', 'always')]);
    });
  });
});
