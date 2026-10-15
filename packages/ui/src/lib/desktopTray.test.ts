import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Event as HappyDomEvent, Window } from 'happy-dom';

import { getDesktopTray, setDesktopTray, TRAY_ENABLED_EVENT } from './desktop';

type TrayInvokeArgs = { enabled?: boolean };

type TestElectronShell = { runtime: string; trayEnabled: boolean };

type TrayStatusPayload = { supported: boolean; enabled: boolean } | null;

describe('desktop tray toggle IPC', () => {
  let dom: Window;
  let calls: Array<{ command: string; args: TrayInvokeArgs }>;
  let invokeImpl: (command: string, args: TrayInvokeArgs) => Promise<TrayStatusPayload>;
  let electronShell: TestElectronShell;

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    calls = [];
    electronShell = { runtime: 'electron', trayEnabled: true };
    invokeImpl = async (command: string, args: TrayInvokeArgs) => {
      calls.push({ command, args });
      if (command === 'desktop_get_tray') return { supported: true, enabled: true };
      if (command === 'desktop_set_tray') return { supported: true, enabled: args.enabled === true };
      return null;
    };
    Object.assign(dom, {
      __OPENCHAMBER_PLATFORM__: 'linux',
      __OPENCHAMBER_ELECTRON__: electronShell,
      __OPENCHAMBER_DESKTOP__: {
        invoke: (command: string, args: TrayInvokeArgs) => invokeImpl(command, args),
      },
    });
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
    });
  });

  afterEach(async () => {
    await dom.happyDOM.close();
  });

  test('getDesktopTray returns the main-process status', async () => {
    expect(await getDesktopTray()).toEqual({ supported: true, enabled: true });
    expect(calls.map((call) => call.command)).toEqual(['desktop_get_tray']);
  });

  test('setDesktopTray persists, mirrors the preload flag, and broadcasts', async () => {
    const seen: unknown[] = [];
    dom.addEventListener(TRAY_ENABLED_EVENT, (event: HappyDomEvent) => {
      seen.push('detail' in event ? event.detail : undefined);
    });
    expect(await setDesktopTray(false)).toEqual({ supported: true, enabled: false });
    expect(calls.map((call) => call.command)).toEqual(['desktop_set_tray']);
    expect(electronShell.trayEnabled).toBe(false);
    expect(seen).toEqual([{ enabled: false }]);
  });

  test('tray IPC rejects malformed payloads', async () => {
    // Statically unrepresentable: well-typed JSON that the schema refuses.
    invokeImpl = async () => JSON.parse('{"supported":true}');
    expect(await getDesktopTray()).toBeNull();
    expect(await setDesktopTray(true)).toBeNull();
  });

  test('tray IPC stays local-only outside the desktop shell', async () => {
    Object.assign(dom, { __OPENCHAMBER_ELECTRON__: undefined });
    expect(await getDesktopTray()).toBeNull();
    expect(await setDesktopTray(true)).toBeNull();
    expect(calls).toEqual([]);
  });
});
