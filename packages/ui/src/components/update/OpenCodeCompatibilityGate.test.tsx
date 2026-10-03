import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { OpenCodeCompatibilityGate } from './OpenCodeCompatibilityGate';
import { recoverOpenCode } from '@/lib/opencode/compatibility';

let root: Root;
let host: HTMLDivElement;
let restoreGlobals: () => void;
let mounts: number;
let requests: string[];
let respond: () => Promise<Response>;

const version = (value: string, canInstall = false) => Response.json({
  state: value.startsWith('2.') ? 'compatible' : 'incompatible',
  version: value,
  installation: 'managed',
  canInstall,
});

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return respond();
    },
  };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  restoreGlobals = () => {
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mounts = 0;
  requests = [];
  respond = async () => version('1.18.30');
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
});

function Application() {
  React.useEffect(() => { mounts += 1; }, []);
  return <main>Application mounted</main>;
}

const render = () => act(async () => {
  root.render(<I18nProvider><OpenCodeCompatibilityGate><Application /></OpenCodeCompatibilityGate></I18nProvider>);
});

test('v1 recovery is visible without mounting application bootstrap or waiting for retries', async () => {
  const splash = document.createElement('div');
  splash.id = 'initial-loading';
  document.body.append(splash);
  await render();
  expect(mounts).toBe(0);
  expect(host.textContent).toContain('OpenCode v2 required');
  expect(host.textContent).toContain('1.18.30');
  expect(host.querySelector('a')?.href).toBe('https://opencode.ai/download');
  expect(document.getElementById('initial-loading')).toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain('/api/opencode/compatibility');
});

test('bootstrap stays unmounted while checking, and starts once for v2', async () => {
  let complete: (response: Response) => void = () => { throw new Error('Missing request'); };
  respond = () => new Promise<Response>((resolve) => { complete = resolve; });
  await render();
  expect(mounts).toBe(0);
  const splash = host.firstElementChild;
  expect(splash?.classList.contains('fixed')).toBe(true);
  expect(splash?.classList.contains('inset-0')).toBe(true);
  expect(splash?.className).toContain('--splash-background');
  expect(splash?.querySelector('svg')?.getAttribute('width')).toBe('120');
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  await act(async () => complete(version('2.0.14')));
  expect(mounts).toBe(1);
  expect(host.textContent).toContain('Application mounted');
});

test('an unavailable compatibility endpoint leaves the existing connection recovery in charge', async () => {
  respond = async () => new Response(null, { status: 503 });
  await render();
  expect(mounts).toBe(1);
  expect(host.textContent).not.toContain('OpenCode v2 required');
});

test('reconnect returns confirmed v1 without restarting, then uses the existing reload route after installation', async () => {
  expect(await recoverOpenCode()).toMatchObject({ state: 'incompatible', compatibility: { version: '1.18.30' } });
  expect(requests).toHaveLength(1);
  requests = [];
  respond = async () => requests.length === 1 ? version('2.0.14') : Response.json({ success: true });
  await recoverOpenCode();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain('/api/config/reload');
});

test('a failed restart remains a failure', async () => {
  respond = async () => requests.length === 1 ? version('2.0.14') : new Response(null, { status: 500 });
  await expect(recoverOpenCode()).rejects.toThrow('OpenCode recovery failed');
});

test('a stale compatibility result cannot mount the app after a runtime switch', async () => {
  const replies: Array<(response: Response) => void> = [];
  respond = () => new Promise<Response>((resolve) => { replies.push(resolve); });
  await render();
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('openchamber:runtime-endpoint-changed'));
  });
  expect(replies).toHaveLength(2);
  await act(async () => replies[1](version('1.18.30')));
  await act(async () => replies[0](version('2.0.14')));
  expect(mounts).toBe(0);
  expect(host.textContent).toContain('OpenCode v2 required');
});

test('update has a disabled progress state and reloads only after the host completes installation', async () => {
  let reloads = 0;
  Object.defineProperty(window.location, 'reload', { configurable: true, value: () => { reloads += 1; } });
  respond = async () => version('1.18.30', true);
  await render();
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent?.includes('Update to OpenCode v2'));
  if (!button) throw new Error('Missing update action');
  let complete: (response: Response) => void = () => { throw new Error('Missing install request'); };
  respond = () => new Promise<Response>((resolve) => { complete = resolve; });
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Installing OpenCode v2');
  expect(requests.filter(url => url.includes('/install-v2'))).toHaveLength(1);
  expect(reloads).toBe(0);
  await act(async () => complete(Response.json({ success: true })));
  expect(reloads).toBe(1);
});

test('failed installation keeps recovery visible and makes retry available', async () => {
  respond = async () => version('1.18.30', true);
  await render();
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent?.includes('Update to OpenCode v2'));
  if (!button) throw new Error('Missing update action');
  respond = async () => new Response(null, { status: 500 });
  await act(async () => button.click());
  expect(mounts).toBe(0);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(button.disabled).toBe(false);
});

const checkAgain = () => {
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent?.includes('Check again'));
  if (!button) throw new Error('Missing check action');
  return act(async () => button.click());
};

test('checking again refreshes v1 without an error, restart, reload, or application bootstrap', async () => {
  let reloads = 0;
  Object.defineProperty(window.location, 'reload', { configurable: true, value: () => { reloads += 1; } });
  await render();
  respond = async () => version('1.18.31', true);
  await checkAgain();
  expect(host.textContent).toContain('1.18.31');
  expect(host.textContent).toContain('Update to OpenCode v2');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(requests).toHaveLength(2);
  expect(requests.every(url => url.includes('/api/opencode/compatibility'))).toBe(true);
  expect(reloads).toBe(0);
  expect(mounts).toBe(0);
});

test('failed or unavailable checks preserve known v1; a successful v1 check clears the error', async () => {
  await render();
  for (const response of [new Response(null, { status: 503 }), Response.json({ state: 'unavailable', version: null, installation: 'managed', canInstall: false })]) {
    respond = async () => response;
    await checkAgain();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain('1.18.30');
    expect(mounts).toBe(0);
  }
  respond = async () => version('1.18.31');
  await checkAgain();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('1.18.31');
});

test('checking again with v2 reloads only after the restart completes', async () => {
  let reloads = 0;
  Object.defineProperty(window.location, 'reload', { configurable: true, value: () => { reloads += 1; } });
  await render();
  let complete: (response: Response) => void = () => { throw new Error('Missing restart request'); };
  respond = async () => requests.at(-1)?.includes('/compatibility') ? version('2.0.14') : new Promise<Response>(resolve => { complete = resolve; });
  await checkAgain();
  expect(requests.at(-1)).toContain('/api/config/reload');
  expect(reloads).toBe(0);
  expect(mounts).toBe(0);
  await act(async () => complete(Response.json({ success: true })));
  expect(reloads).toBe(1);
});

test('a check again result from the previous runtime cannot replace the current version', async () => {
  await render();
  let complete: (response: Response) => void = () => { throw new Error('Missing check request'); };
  respond = () => new Promise<Response>(resolve => { complete = resolve; });
  await checkAgain();
  respond = async () => version('1.18.32');
  await act(async () => window.dispatchEvent(new window.CustomEvent('openchamber:runtime-endpoint-changed')));
  await act(async () => complete(version('1.18.31')));
  expect(host.textContent).toContain('1.18.32');
  expect(host.textContent).not.toContain('1.18.31');
  expect(mounts).toBe(0);
});

test('desktop recovery keeps the instance switcher reachable before app bootstrap', async () => {
  Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
  await render();
  const button = host.querySelector<HTMLButtonElement>('[data-oc-host-switcher]');
  expect(button?.textContent).toContain('Switch instance');
  expect(button?.disabled).toBe(false);
  expect(button?.closest('.app-region-no-drag')).not.toBeNull();
  expect(mounts).toBe(0);
});

test('browser recovery does not offer the desktop instance switcher', async () => {
  await render();
  expect(host.querySelector('[data-oc-host-switcher]')).toBeNull();
});

test('a 2.x below the minimum asks for an update to that minimum, not for v2', async () => {
  respond = async () => Response.json({
    state: 'incompatible',
    version: '2.0.14',
    installation: 'managed',
    minimumVersion: '2.0.15',
    canInstall: true,
  });
  await render();
  expect(mounts).toBe(0);
  expect(host.textContent).toContain('Update OpenCode');
  expect(host.textContent).toContain('requires OpenCode 2.0.15 or newer');
  expect(host.textContent).toContain('2.0.15+');
  expect(host.textContent).not.toContain('OpenCode v2 required');
});

const desktopReadiness = (invoke: () => Promise<boolean>) => {
  Object.defineProperties(window, {
    __OPENCHAMBER_ELECTRON__: { configurable: true, value: { runtime: 'electron' } },
    __OPENCHAMBER_LOCAL_ORIGIN__: { configurable: true, value: 'http://127.0.0.1:3901' },
    __OPENCHAMBER_API_BASE_URL__: { configurable: true, writable: true, value: 'http://127.0.0.1:3901' },
    __OPENCHAMBER_DESKTOP__: { configurable: true, value: { invoke } },
  });
};

test('ready managed desktop starts bootstrap without a compatibility HTTP request', async () => {
  let probes = 0;
  desktopReadiness(async () => { probes += 1; return true; });
  await render();
  expect(probes).toBe(1);
  expect(requests).toHaveLength(0);
  expect(mounts).toBe(1);
});

test('unconfirmed desktop readiness keeps the authoritative compatibility check', async () => {
  desktopReadiness(async () => false);
  await render();
  expect(requests).toHaveLength(1);
  expect(mounts).toBe(0);
  expect(host.textContent).toContain('OpenCode v2 required');
});

test('a failed native readiness read falls back to the compatibility endpoint', async () => {
  desktopReadiness(async () => { throw new Error('Older desktop host'); });
  await render();
  expect(requests).toHaveLength(1);
  expect(mounts).toBe(0);
});

test('switching to a remote runtime cannot reuse an in-flight local readiness verdict', async () => {
  let complete: (ready: boolean) => void = () => { throw new Error('Missing IPC'); };
  desktopReadiness(() => new Promise<boolean>(resolve => { complete = resolve; }));
  await render();
  expect(mounts).toBe(0);
  Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://remote.example' });
  await act(async () => window.dispatchEvent(new window.CustomEvent('openchamber:runtime-endpoint-changed')));
  await act(async () => complete(true));
  expect(mounts).toBe(0);
  expect(requests).toHaveLength(1);
  expect(host.textContent).toContain('OpenCode v2 required');
});
