import { afterAll, jest, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import type { DesktopSettings } from '@/lib/desktop';

export function directoryEnvironment(options: { home?: string; lastDirectory?: string; vscode?: boolean } = {}) {
  const browser = new Window({ url: 'https://local.test/' });
  const globals = ['window', 'document', 'navigator', 'location', 'localStorage', 'CustomEvent'] as const;
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: browser[key] });
  }
  if (options.home) Object.assign(browser, { __OPENCHAMBER_HOME__: options.home });
  if (options.vscode) Object.assign(browser, { __VSCODE_CONFIG__: { workspaceFolder: '', workspaceFolders: [] } });
  if (options.lastDirectory) browser.localStorage.setItem('lastDirectory', options.lastDirectory);
  jest.useFakeTimers();

  const settingsWrites: Array<{ runtimeKey: string; changes: DesktopSettings }> = [];
  let settings: DesktopSettings = {};
  let respond: (url: URL, init?: RequestInit) => Promise<Response> = async (url) => {
    throw new Error(`Unexpected request: ${url}`);
  };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.pathname === '/api/config/settings') {
      if (init?.method === 'PUT' || init?.method === 'PATCH') {
        const changes = JSON.parse(String(init.body));
        settingsWrites.push({ runtimeKey: url.hostname, changes });
        settings = { ...settings, ...changes };
      }
      return Response.json(settings);
    }
    if (url.pathname === '/auth/token') return Response.json({}, { status: 404 });
    if (url.pathname === '/auth/session') return Response.json({ authenticated: true });
    return respond(url, init);
  });

  afterAll(() => {
    fetch.mockRestore();
    jest.useRealTimers();
    for (const key of globals) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    void browser.happyDOM.close();
  });

  return {
    storage: browser.localStorage,
    settingsWrites,
    respond(handler: typeof respond) { respond = handler; },
    async settle() {
      for (let step = 0; step < 40; step += 1) await Promise.resolve();
      jest.advanceTimersByTime(300);
      for (let step = 0; step < 40; step += 1) await Promise.resolve();
    },
  };
}
