import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { gc } from 'bun';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const fetchCalls: string[] = [];
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: { query?: Record<string, string | undefined> }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(init?.query ?? {})) {
      if (value !== undefined) query.set(key, value);
    }
    fetchCalls.push(`${path}?${query.toString()}`);
    return { ok: true, blob: async () => ({ size: 3 }) };
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime-a' }));

const { useMarkdownLocalAssets } = await import('./useMarkdownLocalAssets');

function Preview({ container, filePath, onOpenFile, enabled }: {
  container: HTMLElement | null;
  filePath: string;
  onOpenFile: (path: string) => void;
  enabled: boolean;
}) {
  useMarkdownLocalAssets({ container, filePath, workspaceRoot: '/repo', onOpenFile, enabled });
  return null;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('useMarkdownLocalAssets', () => {
  let windowInstance: Window;
  let root: Root;
  let container: HTMLDivElement;
  let created: string[];

  beforeEach(() => {
    windowInstance = new Window();
    created = [];
    let counter = 0;
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      HTMLAnchorElement: windowInstance.HTMLAnchorElement,
      HTMLImageElement: windowInstance.HTMLImageElement,
      Element: windowInstance.Element,
      MouseEvent: windowInstance.MouseEvent,
      MutationObserver: windowInstance.MutationObserver,
      AbortSignal: Object.assign(windowInstance.AbortSignal, { timeout: () => undefined }),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.assign(globalThis.URL, {
      createObjectURL: () => { created.push(`blob:${counter += 1}`); return created[created.length - 1]; },
      revokeObjectURL: () => {},
    });
    fetchCalls.length = 0;
    const host = document.createElement('div');
    container = document.createElement('div');
    document.body.append(host, container);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  test('rewrites an image that is rendered after the hook attached, resolved against the file directory', async () => {
    await act(async () => {
      root.render(<Preview container={container} filePath="/repo/docs/report.md" onOpenFile={() => {}} enabled />);
    });
    expect(fetchCalls).toEqual([]);

    // A collection between observe() and the mutation must not detach the
    // observer. Forcing one here makes that deterministic; see
    // bun-patches/happy-dom@18.0.1.patch.
    gc(true);

    // The markdown pipeline inserts the DOM later, the way the worker does.
    const image = document.createElement('img');
    image.setAttribute('src', './shots/a.png');
    container.appendChild(image);
    await flush();
    await flush();

    expect(fetchCalls).toEqual(['/api/fs/raw?path=%2Frepo%2Fdocs%2Fshots%2Fa.png&directory=%2Frepo']);
    expect(image.getAttribute('src')).toBe('blob:1');
    expect(image.getAttribute('data-oc-local-asset')).toBe('/repo/docs/shots/a.png');
  });

  test('reads a target outside the workspace the way the editor does, and leaves absolute URLs alone', async () => {
    const image = document.createElement('img');
    image.setAttribute('src', '../../tmp/shot.png');
    const remote = document.createElement('img');
    remote.setAttribute('src', 'https://example.test/x.png');
    container.append(image, remote);
    await act(async () => {
      root.render(<Preview container={container} filePath="/repo/docs/report.md" onOpenFile={() => {}} enabled />);
    });
    await flush();

    expect(fetchCalls).toEqual(['/api/fs/raw?path=%2Ftmp%2Fshot.png&allowOutsideWorkspace=true&directory=%2Frepo']);
    expect(remote.getAttribute('src')).toBe('https://example.test/x.png');
  });

  test('opens a relative link in the viewer, scrolls to a heading for a fragment, and ignores external links', async () => {
    const opened: string[] = [];
    const scrolled: string[] = [];
    const local = document.createElement('a');
    local.setAttribute('href', 'data.csv');
    const hash = document.createElement('a');
    hash.setAttribute('href', '#next-steps');
    const external = document.createElement('a');
    external.setAttribute('href', 'https://example.test');
    const heading = document.createElement('h2');
    heading.textContent = 'Next steps!';
    heading.scrollIntoView = () => { scrolled.push(heading.textContent ?? ''); };
    container.append(local, hash, external, heading);
    await act(async () => {
      root.render(<Preview container={container} filePath="/repo/docs/report.md" onOpenFile={(path) => opened.push(path)} enabled />);
    });

    const click = (target: HTMLElement) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click(local)).toBe(true);
    expect(click(hash)).toBe(true);
    expect(click(external)).toBe(false);
    expect(opened).toEqual(['/repo/docs/data.csv']);
    expect(scrolled).toEqual(['Next steps!']);
  });

  test('does nothing while disabled', async () => {
    const image = document.createElement('img');
    image.setAttribute('src', './a.png');
    container.append(image);
    await act(async () => {
      root.render(<Preview container={container} filePath="/repo/docs/report.md" onOpenFile={() => {}} enabled={false} />);
    });
    await flush();
    expect(fetchCalls).toEqual([]);
    expect(image.getAttribute('src')).toBe('./a.png');
  });
});
