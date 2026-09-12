import React, { act } from 'react';
import { expect } from 'bun:test';
import { Window } from 'happy-dom';
import { Worker as NodeWorker } from 'node:worker_threads';
import type { WorkerRequest, WorkerResponse } from '@pierre/diffs/worker';
import type { GitStatus } from '@/lib/api/types';

const WorkerEventTarget = globalThis.EventTarget;
const WorkerMessageEvent = globalThis.MessageEvent;
const workerThreads = new Set<NodeWorker>();
const pendingHighlightRequests = new Set<string>();
const workerFailures: Error[] = [];
const workerEntry = import.meta.resolve('@pierre/diffs/worker/worker.js');

// Run the installed Pierre worker unchanged. Only its browser message boundary
// is adapted to Node, so inline slots use real rendered diff rows in this test.
class FixtureHighlightWorker extends WorkerEventTarget {
  private worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from 'node:worker_threads';
    globalThis.postMessage = (data) => parentPort.postMessage(data);
    globalThis.self = { addEventListener(type, listener) {
      if (type === 'message') parentPort.on('message', (data) => listener({ data }));
    } };
    await import(workerData);
  `)}`), { workerData: workerEntry });

  constructor() {
    super();
    workerThreads.add(this.worker);
    this.worker.on('message', (data: WorkerResponse) => {
      pendingHighlightRequests.delete(data.id);
      this.dispatchEvent(new WorkerMessageEvent('message', { data }));
    });
    this.worker.on('error', (error) => workerFailures.push(error));
  }

  postMessage(request: WorkerRequest) {
    pendingHighlightRequests.add(request.id);
    this.worker.postMessage(request);
  }

  terminate() { return this.worker.terminate(); }
}

export const closeDiffHunkWorkers = async () => {
  await Promise.all([...workerThreads].map((worker) => worker.terminate()));
  workerThreads.clear();
};

export async function exerciseDiffHunkActions(snapshotCase?: 'cold' | 'cached' | 'cold-single', layout: 'inline' | 'side-by-side' = 'inline') {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, Window: dom.Window, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement, Node: dom.Node,
    ShadowRoot: dom.ShadowRoot, Document: dom.Document, Worker: FixtureHighlightWorker,
    SVGElement: dom.SVGElement, DocumentFragment: dom.DocumentFragment, Text: dom.Text, Range: dom.Range,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  document.documentElement.style.fontSize = '16px';
  const originalFetch = globalThis.fetch;
  // Unrelated bootstrap I/O stays pending; the Git adapter below owns this
  // scenario's reads and mutations. No real account or filesystem is touched.
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), originalFetch);
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { MultiFileDiffEntry } = await import('@/components/views/DiffView');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useGitStore } = await import('@/stores/useGitStore');
  const changes = snapshotCase === 'cold-single' ? [1] : [1, 25, 50];
  let remaining = [...changes];
  const cold = snapshotCase === 'cold' || snapshotCase === 'cold-single';
  let fullContext = cold;
  let currentVersion = cold ? 2 : 1;
  let fullVersion = 1;
  let deferVersions = cold;
  let releaseFull: (() => void) | undefined;
  let releaseCanonical: (() => void) | undefined;
  let openedPatch: string | null = null;
  let historical = false;
  let failReads = false;
  let normalReads = 0;
  let mutations = 0;
  const makePatch = (full: boolean, version = currentVersion) => {
    const header = `diff --git a/file.txt b/file.txt\nindex ${'a'.repeat(40)}..${String(version).repeat(40)} 100644\n--- a/file.txt\n+++ b/file.txt\n`;
    const ranges = full ? [[0, 60]] : remaining.map((line) => [Math.max(0, line - 3), line + 4]);
    return header + ranges.map(([start, end]) => `@@ -${start + 1},${end - start} +${start + 1},${end - start} @@\n` +
      Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return remaining.includes(index) ? `-line${index}\n+v${version}-changed${index}\n` : ` line${index}\n`;
      }).join('')).join('');
  };
  const file = { path: 'file.txt', index: 'M', working_dir: 'M', insertions: 3, deletions: 3, isNew: false };
  const status: GitStatus = { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [file], isClean: false, diffStats: {} };
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git,
    checkIsGitRepository: async () => true,
    getGitStatus: async () => status,
    getGitDiff: async (_directory: string, options: { path?: string; staged?: boolean; contextLines?: number }) => {
      if (failReads) throw new Error('Refresh unavailable');
      if (options.contextLines === 3) normalReads += 1;
      const full = (options.contextLines ?? 3) > 3;
      const response = { diff: makePatch(full, full ? fullVersion : currentVersion) };
      if (deferVersions) return new Promise<{ diff: string }>((resolve) => {
        if (full) releaseFull = () => resolve(response);
        else releaseCanonical = () => resolve(response);
      });
      return response;
    },
    stageGitHunk: async (_directory: string, _path: string, patch: string) => {
      expect(patch).toContain(`+v${currentVersion}-changed${remaining[0]}\n`);
      mutations += 1;
      remaining = remaining.slice(1);
    },
  } };
  useGitStore.getState().setActiveDirectory('/repo');
  const container = document.createElement('div');
  container.dataset.diffVirtualRoot = '';
  container.getBoundingClientRect = () => new dom.DOMRect(0, 0, 1280, 2000);
  Object.defineProperty(container, 'clientHeight', { value: 2000 });
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => root.render(<I18nProvider><SyncProvider sdk={opencodeClient.getSdkClient()} directory=""><RuntimeAPIContext.Provider value={apis}>
    <MultiFileDiffEntry directory="/repo" file={file} layout={layout} wrapLines={false} isSelected={false}
      isExpanded isMounted onSelect={() => {}} onExpandedChange={() => {}} registerSectionRef={() => {}}
      showOpenInEditorAction onOpenInEditor={(_path, diff) => { openedPatch = diff?.patch ?? null; }}
      hunkActionsEnabled={!historical} loadFullFiles={fullContext}
      initialDiffData={historical ? { original: '', modified: '', patch: makePatch(false), contextMode: 'patch' } : null} />
  </RuntimeAPIContext.Provider></SyncProvider></I18nProvider>));
  const click = async (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    await act(async () => element.click());
  };
  const waitForActions = async (count: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (workerFailures.length > 0) throw workerFailures[0];
      if (container.querySelectorAll('[data-hunk-actions]').length === count) {
        for (const [index, line] of remaining.entries()) {
          const target = container.querySelector<HTMLElement>(`[data-hunk-action-target="${index}"]`);
          const wrapper = target?.parentElement;
          const slots = container.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('slot') ?? [];
          const slot = wrapper ? [...slots].find((candidate) => candidate.assignedElements().includes(wrapper)) : undefined;
          expect(slot?.name).toBe(`annotation-additions-${line + 1}`);
          expect(target?.style.height).toBe('0px');
          expect(slot?.closest('[data-line-annotation]')).not.toBeNull();
          if (layout === 'side-by-side') expect(slot?.closest('[data-additions]')).not.toBeNull();
        }
        return;
      }
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const host = container.querySelector('diffs-container');
    throw new Error(`Missing inline actions: ${JSON.stringify({
      expected: count, targets: host?.querySelectorAll('[data-hunk-action-target]').length,
      slots: [...(host?.shadowRoot?.querySelectorAll('slot') ?? [])].map((slot) => ({ name: slot.name, assigned: slot.assignedElements().length })),
      shadow: host?.shadowRoot?.innerHTML.slice(-1500),
    })}`);
  };
  try {
    await render();
    if (snapshotCase) {
      if (cold) {
        if (!releaseFull || !releaseCanonical) throw new Error('Both snapshot reads must start');
        await act(async () => { releaseFull?.(); releaseCanonical?.(); });
      } else {
        currentVersion = 2;
        fullVersion = 2;
        fullContext = true;
        await render();
      }
      expect(container.textContent).toContain('Refresh the diff and try again');
      expect(container.querySelector('[data-hunk-actions]')).toBeNull();
      expect(mutations).toBe(0);
      deferVersions = false;
      fullVersion = currentVersion;
      const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
      if (!retry) throw new Error('Missing snapshot retry');
      await act(async () => retry.click());
      await waitForActions(changes.length);
      expect(container.querySelectorAll('[data-hunk-actions]')).toHaveLength(changes.length);
      expect(normalReads).toBe(2);
      await click('button[title="Open this file in editor at change"]');
      expect(openedPatch).toContain('+v2-changed1\n');
      await click('button[aria-label="Stage hunk 1"]');
      expect(mutations).toBe(1);
      return;
    }
    await waitForActions(3);
    expect(container.querySelectorAll('[data-hunk-actions]')).toHaveLength(3);
    expect(normalReads).toBe(1);
    fullContext = true;
    await render();
    await waitForActions(3);
    expect(container.querySelectorAll('[data-hunk-actions]')).toHaveLength(3);
    expect(normalReads).toBe(1);
    await click('button[aria-label="Stage hunk 1"]');
    expect(mutations).toBe(1);
    await waitForActions(2);
    expect(container.querySelectorAll('[data-hunk-actions]')).toHaveLength(2);
    expect(normalReads).toBe(2);
    failReads = true;
    await click('button[aria-label="Stage hunk 1"]');
    expect(mutations).toBe(2);
    expect(container.textContent).toContain('Refresh unavailable');
    expect(container.querySelector('[data-hunk-actions]')).toBeNull();
    failReads = false;
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing retry');
    await act(async () => retry.click());
    expect(container.textContent).not.toContain('Refresh unavailable');
    await waitForActions(1);
    expect(container.querySelectorAll('[data-hunk-actions]')).toHaveLength(1);
    await click('button[aria-label="Stage hunk 1"]');
    expect(mutations).toBe(3);
    expect(container.querySelector('[data-hunk-actions]')).toBeNull();
    remaining = [...changes];
    historical = true;
    await render();
    expect(container.querySelector('[data-hunk-actions]')).toBeNull();
    expect(mutations).toBe(3);
  } finally {
    await act(async () => root.unmount());
    const deadline = Date.now() + 5000;
    while (pendingHighlightRequests.size > 0 && workerFailures.length === 0 && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
}
