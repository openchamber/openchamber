import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountInspectorView } from './RemoteBrowserInspector.test-support';
import { RemoteSurfaceDevTools } from '@/lib/browser/remoteSurfaceDevTools';
import type { DevToolsCommand } from '@/lib/browser/remoteSurfaceDevToolsProtocol';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import { RemoteBrowserDevTools } from './RemoteBrowserDevTools';
import { remoteDevToolsThemeMessageSchema } from './remoteDevToolsTheme';

const clients = new Set<RemoteSurfaceDevTools>();
afterEach(() => { for (const client of clients) client.dispose(); clients.clear(); });

type BridgeCapture = { port: MessagePort | null };

const themeView = (theme: Theme, client: RemoteSurfaceDevTools) => {
  const context: ThemeContextValue = {
    currentTheme: theme,
    availableThemes: [theme],
    setTheme: () => undefined,
    customThemesLoading: false,
    reloadCustomThemes: async () => undefined,
    isSystemPreference: false,
    setSystemPreference: () => undefined,
    themeMode: theme.metadata.variant,
    setThemeMode: () => undefined,
    lightThemeId: 'openchamber-light',
    darkThemeId: 'openchamber-dark',
    setLightThemePreference: () => undefined,
    setDarkThemePreference: () => undefined,
  };
  return <ThemeSystemContext.Provider value={context}>
    <RemoteBrowserDevTools devtools={client} onUseSimpleInspector={() => undefined} />
  </ThemeSystemContext.Provider>;
};

test('keeps loading until the exact frontend has connected and built its UI', async () => {
  const commands: DevToolsCommand[] = [];
  const client = new RemoteSurfaceDevTools((command) => { commands.push(command); return true; });
  clients.add(client);
  client.setAttachment({ tabId: 'sc:one', attachmentRequestId: 'attachment-one' });
  client.setOpen(true);
  const start = commands.find((command) => command.type === 'devtoolsStart');
  if (!start) throw new Error('Expected start command');
  client.receive(JSON.stringify({ ...start, type: 'devtoolsStarted', devtoolsId: 'devtools-one',
    frontendPath: `/api/browser-devtools/${'a'.repeat(32)}/inspector.html` }));
  const lightTheme = getDefaultTheme(false);
  const { host, render } = await mountInspectorView(themeView(lightTheme, client));
  const frame = host.querySelector('iframe');
  if (!frame) throw new Error('Expected the frontend frame');
  const frontend = new Window({ url: frame.src });
  Object.defineProperty(frame, 'contentWindow', { configurable: true, value: frontend });
  const receivedPortMessages: unknown[] = [];
  const bridge: BridgeCapture = { port: null };
  Object.defineProperty(frontend, 'postMessage', { configurable: true, value:
    (_message: { readonly type: string }, _targetOrigin: string, ports: readonly MessagePort[]) => {
      bridge.port = ports[0] ?? null;
      if (!bridge.port) return;
      bridge.port.onmessage = (event) => receivedPortMessages.push(event.data);
      bridge.port.start();
    },
  });
  if (!frame?.contentWindow) throw new Error('Expected the frontend frame');
  const source = frame.contentWindow;
  const announce = async (type: string, devtoolsId = 'devtools-one') => {
    await act(async () => window.dispatchEvent(new MessageEvent('message', {
      source, origin: window.location.origin, data: { type, devtoolsId, attachmentRequestId: 'attachment-one' },
    })));
  };

  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await announce('openchamber-devtools-ready');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const initialTheme = receivedPortMessages
    .map((message) => remoteDevToolsThemeMessageSchema.safeParse(message))
    .find((result) => result.success);
  expect(initialTheme?.data.variant).toBe('light');
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await announce('openchamber-devtools-loaded', 'superseded-devtools');
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await announce('openchamber-devtools-loaded');
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await announce('openchamber-devtools-themed');
  expect(host.querySelector('[role="status"]')).toBeNull();
  const frameBeforeThemeSwitch = host.querySelector('iframe');
  await render(themeView(getDefaultTheme(true), client));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(host.querySelector('iframe')).toBe(frameBeforeThemeSwitch);
  const updatedTheme = remoteDevToolsThemeMessageSchema.safeParse(receivedPortMessages.at(-1));
  expect(updatedTheme.success ? updatedTheme.data.variant : null).toBe('dark');
  bridge.port?.close();
  await frontend.happyDOM.abort();
});
