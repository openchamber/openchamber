import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorView } from '@codemirror/view';

test('mounted conflicted A survives unmount, B, and return with its error and peer body intact', async () => {
  const dom = new Window({ url: 'http://runtime.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Document: dom.Document, Text: dom.Text, Range: dom.Range,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previousFetch = globalThis.fetch;
  const plans = new Map([['A', '# Plan A\n\nOriginal A'], ['B', '# Plan B\n\nOriginal B']]);
  const link = (id: string) => ({ id, file: `${id}.md`, title: `Plan ${id}`, createdAt: 1, pinned: false });
  const writes: Array<{ raw: string; expectedRaw: string }> = [];
  let failPlanRead = false;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
    if (url.pathname === '/api/fs/home') return Response.json({ home: '/fixture' });
    if (url.pathname === '/api/config/settings') return Response.json({});
    if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    const id = url.pathname.split('/plans/')[1];
    if (id) {
      if (init?.method === 'PUT') {
        const body: { raw: string; expectedRaw: string } = JSON.parse(String(init.body));
        writes.push(body);
        if (body.expectedRaw !== plans.get(id)) return Response.json({ error: 'Plan changed; reload before saving' }, { status: 409 });
        plans.set(id, body.raw);
        return Response.json({ plan: link(id), raw: body.raw });
      }
      if (failPlanRead) return Response.json({ error: 'Plan read offline' }, { status: 503 });
      if (!plans.has(id)) return Response.json({ error: 'Plan not found' }, { status: 404 });
      return Response.json({ ...link(id), raw: plans.get(id), body: plans.get(id), path: null });
    }
    if (url.pathname.startsWith('/api/project-context/')) return Response.json({ notes: [], todos: [], plans: [...plans.keys()].map(link), sharedPlansDir: null });
    return Response.json({ error: 'Unavailable in fixture' }, { status: 503 });
  }, previousFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useProjectContextStore } = await import('@/stores/useProjectContextStore');
  const { resolveProjectContextId } = await import('@/lib/projectContextApi');
  const { getSavedPlanDrafts } = await import('@/lib/savedPlanDrafts');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { switchRuntimeEndpoint, getRuntimeApiBaseUrl } = await import('@/lib/runtime-switch');
  const { PlanView } = await import('./PlanView');
  const projectRef = { id: 'plan-fixture', path: '/plan-fixture' };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const apis = createWebAPIs();
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const render = async (id: string | null, owner = projectRef) => {
    await act(async () => root.render(<I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={apis}>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/plan-fixture">
        {id && <PlanView key={id} savedProjectPlan={{ projectRef: owner, planId: id }} />}
      </SyncProvider>
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider>));
    await settle();
  };
  const editor = () => {
    const element = host.querySelector('.cm-editor');
    if (!(element instanceof HTMLElement)) throw new Error(`Editor missing: ${host.textContent}`);
    const view = EditorView.findFromDOM(element);
    if (!view) throw new Error('Editor view missing');
    return view;
  };
  const draftKey = (id: string) => JSON.stringify(['saved-plan', getRuntimeKey(), resolveProjectContextId(projectRef), id]);
  try {
    useProjectContextStore.getState().reset();
    // The plan list is authoritative and contains both existing plans.
    await useProjectContextStore.getState().load(projectRef);
    await render('A');
    expect(editor().state.doc.toString()).toBe(plans.get('A'));
    const original = plans.get('A');
    await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: '# Plan A\n\nDIRTY KEEPME' } }));
    plans.set('A', '# Plan A\n\nPEER CHANGED A');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(host.textContent).toContain('Save failed');
    expect(writes.at(-1)?.expectedRaw).toBe(original);
    await render(null);
    await render('B');
    expect(editor().state.doc.toString()).toBe(plans.get('B'));
    expect(host.textContent).not.toContain('Save failed');
    await act(async () => editor().dispatch({ changes: { from: 0, to: editor().state.doc.length, insert: '# Plan B\n\nSaved B' } }));
    await render(null);
    await getSavedPlanDrafts().queue.pendingFor(draftKey('B'));
    expect(plans.get('B')).toBe('# Plan B\n\nSaved B');
    expect(getSavedPlanDrafts().restore(draftKey('B'))).toBeUndefined();
    await render('A');
    expect(editor().state.doc.toString()).toContain('DIRTY KEEPME');
    expect(host.textContent).toContain('Save failed');
    expect(host.querySelector('[title="Plan changed; reload before saving"]')).not.toBeNull();
    expect(plans.get('A')).toBe('# Plan A\n\nPEER CHANGED A');
    await render(null);
    failPlanRead = true;
    await render('A');
    expect(host.textContent).toContain('Could not load this plan');
    expect(getSavedPlanDrafts().restore(draftKey('A'))?.content).toContain('DIRTY KEEPME');
    await render(null);
    failPlanRead = false;
    await render('A', { id: 'other-owner', path: '/other-owner' });
    expect(editor().state.doc.toString()).toBe(plans.get('A'));
    expect(host.textContent).not.toContain('Save failed');
    await render(null);
    const originalRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other-runtime.test', runtimeKey: 'other-runtime' }));
    await render('A');
    expect(editor().state.doc.toString()).toBe(plans.get('A'));
    expect(host.textContent).not.toContain('Save failed');
    await render(null);
    await act(async () => switchRuntimeEndpoint(originalRuntime));
    await render('A');
    expect(editor().state.doc.toString()).toContain('DIRTY KEEPME');
    expect(host.textContent).toContain('Save failed');
    await render(null);
    plans.delete('A');
    const writeCount = writes.length;
    await render('A');
    expect(host.textContent).toContain('Could not load this plan');
    expect(editor().state.doc.toString()).toBe('');
    expect(host.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(writes.length).toBe(writeCount);
    expect(getSavedPlanDrafts().restore(draftKey('A'))).toBeUndefined();
    expect(plans.has('A')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    useProjectContextStore.getState().reset();
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
