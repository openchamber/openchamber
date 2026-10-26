import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useMarkdownLocalAssets, openMarkdownDocumentLink } from './useMarkdownLocalAssets';
import { MarkdownMediaProvider } from '@/components/chat/markdown/MarkdownMediaContext';
import { MarkdownImage } from '@/components/chat/markdown/MarkdownMedia';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); });

describe('document Markdown asset integration', () => {
  test('returns document ownership before rendering without observing or mutating a subtree', async () => {
    const dom = new Window();
    Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const open = () => {};
    let assets: ReturnType<typeof useMarkdownLocalAssets>;
    function Preview() {
      assets = useMarkdownLocalAssets({ filePath: '/repo/docs/report.md', workspaceRoot: '/repo', onOpenFile: open, enabled: true, colorScheme: 'dark' });
      return null;
    }
    await act(async () => root?.render(<Preview />));
    expect(assets).toEqual({ filePath: '/repo/docs/report.md', workspaceRoot: '/repo', onOpenFile: open, colorScheme: 'dark' });
  });
  test('disabled previews and absent files have no document ownership', async () => {
    const dom = new Window();
    Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
    root = createRoot(document.createElement('div'));
    let assets: ReturnType<typeof useMarkdownLocalAssets>;
    function Preview({ enabled, filePath }: { enabled: boolean; filePath: string | null }) {
      assets = useMarkdownLocalAssets({ enabled, filePath, workspaceRoot: '/repo', onOpenFile: () => {}, colorScheme: 'light' });
      return null;
    }
    await act(async () => root?.render(<Preview enabled={false} filePath="/repo/plan.md" />));
    expect(assets).toBeUndefined();
    await act(async () => root?.render(<Preview enabled filePath={null} />));
    expect(assets).toBeUndefined();
  });
  test('document links open sibling files and scroll fragments within their own preview only', async () => {
    const dom = new Window();
    Object.assign(globalThis, { window: dom, document: dom.document, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const opened: string[] = []; const scrolled: string[] = [];
    const assets = { filePath: '/repo/docs/readme.md', workspaceRoot: '/repo', colorScheme: 'light' as const, onOpenFile: (path: string) => opened.push(path) };
    const anchor = (href: string) => <a href={href} onClick={(event) => { openMarkdownDocumentLink(event, assets); }}>{href}</a>;
    await act(async () => root?.render(<><section data-markdown-content><h2>Next steps!</h2>{anchor('data%20file.csv?download#section')}{anchor('#next-steps')}{anchor('https://example.test')}</section><section data-markdown-content><h2>Next steps!</h2></section></>));
    const headings = host.querySelectorAll('h2');
    headings[0]!.scrollIntoView = () => { scrolled.push('own'); };
    headings[1]!.scrollIntoView = () => { scrolled.push('other'); };
    const links = host.querySelectorAll('a');
    const click = (index: number, ctrlKey = false) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey });
      links[index]!.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click(0)).toBe(true); expect(click(1)).toBe(true); expect(click(2)).toBe(false); expect(click(0, true)).toBe(false);
    expect(opened).toEqual(['/repo/docs/data file.csv']); expect(scrolled).toEqual(['own']);
  });
  test('the Files and personal Plan caller contract resolves media before exposing a browser src', async () => {
    const dom = new Window({ url: 'https://app.test' });
    // happy-dom's observer never reports, and a document image waits until it is near the view.
    Object.defineProperty(dom, 'IntersectionObserver', { configurable: true, value: undefined });
    Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.test' });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => { requests.push(String(input)); return new Response('image', { headers: { 'content-type': 'image/png' } }); };
    Object.assign(URL, { createObjectURL: () => 'blob:owned', revokeObjectURL: () => {} });
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    function Preview({ filePath }: { filePath: string }) {
      const assets = useMarkdownLocalAssets({ enabled: true, filePath, workspaceRoot: '/repo', onOpenFile: () => {}, colorScheme: 'light' });
      return <MarkdownMediaProvider content={filePath} mode="document" directory="/repo" settled documentAssets={assets}><MarkdownImage src="../assets/flow.png" /></MarkdownMediaProvider>;
    }
    try {
      await act(async () => root?.render(<Preview filePath="/repo/docs/report.md" />));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests[0]).toContain('path=%2Frepo%2Fassets%2Fflow.png');
      expect(requests[0]).not.toContain('allowOutsideWorkspace=true');
      expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:owned');
      await act(async () => root?.render(<Preview filePath="/home/user/plans/plan.md" />));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(requests[1]).toContain('path=%2Fhome%2Fuser%2Fassets%2Fflow.png');
      expect(requests[1]).toContain('allowOutsideWorkspace=true');
      expect(host.querySelector('img')?.getAttribute('data-oc-media-source')).toBe('../assets/flow.png');
    } finally { globalThis.fetch = originalFetch; }
  });
});
