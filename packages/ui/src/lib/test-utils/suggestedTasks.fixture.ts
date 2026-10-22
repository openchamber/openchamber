import { Window } from 'happy-dom';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { DesktopSettings } from '@/lib/desktop';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { getSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import type { SuggestedTasksSettings, Suggestion, SuggestionInbox } from '@/lib/suggestedTasksApi';

export const suggestion = (patch: Partial<Suggestion> = {}): Suggestion => ({
  id: 'suggestion-1', runId: 'run-1', lensId: 'lens-1', lensName: 'Security',
  title: 'Check input', body: 'Validate the input.', files: [], confidence: 'high',
  severity: 'high', createdAt: 1, status: 'open', ...patch,
});

export const inbox = (suggestions: Suggestion[] = []): SuggestionInbox => ({ suggestions, runs: [], issueProviders: [] });

export const settings = (): SuggestedTasksSettings => ({
  config: {
    enabled: true,
    schedule: { kind: 'manual', time: '09:00', weekdays: [1], cron: '' },
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    scope: { include: [], exclude: [], baseBranch: '', incremental: true },
    limits: { maxSuggestions: 10, tokenBudget: null, minConfidence: 'low', minSeverity: 'low' },
    dedupe: { dismissed: true, todos: true }, notify: true, archiveScanSessions: true,
    lenses: [{ id: 'lens-1', name: 'Security', enabled: true, prompt: 'Check inputs.', model: { useDefaults: true }, web: false, action: 'suggest' }],
  },
  repoLenses: [{ id: 'repo-1', file: 'review.md', status: 'disabled', name: 'Review' }],
  presets: [], nextRunAt: null,
});

/**
 * A real HTTP boundary with a per-test ephemeral port and controllable responses.
 * `settingsDocument` answers `/api/config/settings`; the stores sync from it in
 * the background, and an empty document empties the projects store.
 */
export const serveSuggestedTasks = async (
  handle: (request: Request) => Response | Promise<Response>,
  settingsDocument: DesktopSettings = {},
) => {
  const server = createServer(async (incoming, outgoing) => {
    try {
      incoming.setEncoding('utf8');
      let body = '';
      for await (const chunk of incoming) body += chunk;
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method, body: body || undefined });
      const path = new URL(request.url).pathname;
      const response = path.includes('url-token') ? Response.json({ error: 'Not found' }, { status: 404 })
        : path === '/api/fs/home' ? Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' })
          : path === '/api/config/settings' ? Response.json(settingsDocument) : await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = z.object({ port: z.number().int().positive() }).parse(server.address());
  const url = new URL(`http://127.0.0.1:${address.port}`);
  getSuggestedTasksRuntime();
  switchRuntimeEndpoint({ apiBaseUrl: url.origin, runtimeKey: `test-${address.port}` });
  return {
    url, port: address.port,
    stop: async (force: boolean) => {
      const closed = new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
      if (force) server.closeAllConnections();
      await closed;
    },
  };
};

export const deferred = <T>() => {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise not initialized'); };
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

export const installSuggestedTasksDom = () => {
  const window = new Window({ url: 'http://localhost/' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true
      : name === 'requestAnimationFrame' ? window.requestAnimationFrame.bind(window)
        : name === 'cancelAnimationFrame' ? window.cancelAnimationFrame.bind(window)
          : name === 'getComputedStyle' ? window.getComputedStyle.bind(window) : window[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return {
    window,
    restore: async () => {
      await window.happyDOM.abort();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};
