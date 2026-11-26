import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { ChangeRequestContext, Issue, RuntimeAPIs, SourceControlReadContext } from '@/lib/api/types';
import type { ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { acmeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import type { ReferencePickerConfirmFailure } from '@/components/references/ReferencePickerDialog';

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!DOCTYPE html><html><body></body></html>');
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  ...Object.fromEntries(([
    'Window', 'Node', 'Text', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'HTMLFormElement', 'Range', 'Selection', 'DocumentFragment', 'Event', 'KeyboardEvent',
    'MouseEvent', 'ClipboardEvent', 'DataTransfer', 'FocusEvent', 'InputEvent', 'CustomEvent', 'MutationObserver',
    'ResizeObserver', 'IntersectionObserver', 'HTMLDivElement', 'HTMLSpanElement',
    'SVGElement', 'ShadowRoot', 'CSSStyleSheet', 'DOMParser',
  ] satisfies (keyof Window)[]).map((name) => [name, browser[name]])),
  matchMedia: browser.matchMedia.bind(browser), getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements, IS_REACT_ACT_ENVIRONMENT: true,
});

const DIRECTORY = '/references-fixture';
const location = { directory: DIRECTORY, project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY } };
const responseFor = (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path === '/api/config/settings') return Response.json({ projects: [{ id: 'project', path: DIRECTORY }] });
  if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (path.endsWith('/location')) return Response.json(location);
  if (path.endsWith('/session/active')) return Response.json({ data: {} });
  if (path === '/api/config' || path === '/api/project') return Response.json([]);
  if (path.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
  if (path.endsWith('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  return Response.json({ location, data: [], cursor: {} });
};
let resolvePortalUrl: ((url: string) => Response) | undefined;
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path === '/api/guests/portal/service/request' && resolvePortalUrl) {
    const { body } = JSON.parse(String(init?.body));
    return resolvePortalUrl(JSON.parse(body).url);
  }
  return responseFor(input);
});
plugin({
  name: 'composer-references-vite-modules',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: DIRECTORY, repositoryId: 'repo',
  accountId: 'account', bindingRevision: 1, primaryRemote: 'origin',
};
let readContext = context;
const referenceSources = await import('@/components/references/referenceSources');
mock.module('@/components/references/referenceSources', () => ({
  ...referenceSources,
  useRepositoryReadContext: () => readContext,
  useRepositoryFolderReadContexts: (folders: readonly string[]) => folders.map((directory) => ({ directory, context: readContext })),
}));

type Confirm = (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null>;
let confirm: Confirm | null = null;
let closePicker: (() => void) | null = null;
// Replace picker chrome only. Confirmation, resolution and composer state remain real.
mock.module('@/components/references/ReferencePickerDialog', () => ({
  ReferencePickerDialog: (props: { onConfirm: Confirm; onOpenChange: (open: boolean) => void }) => {
    confirm = props.onConfirm;
    closePicker = () => props.onOpenChange(false);
    return null;
  },
}));
mock.module('../composer/ui/ComposerAttachmentControls', () => ({
  ComposerAttachmentControls: ({ openGitHubPicker }: { openGitHubPicker: () => void }) => (
    <button onClick={openGitHubPicker}>Open references</button>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useSessionUIStore, DraftSendError } = await import('@/sync/session-ui-store');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
const { useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
const { EditorView } = await import('@codemirror/view');
const { openSessionDraft } = await import('@/components/session/sidebar/works/openSessionDraft');
const { useInputStore } = await import('@/sync/input-store');
const { useBtwStore } = await import('@/stores/useBtwStore');
const { createChatDraftIdentity, readChatDraft, writeChatDraft } = await import('@/lib/chatDraftPersistence');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { readLinkedReferences, useLinkedReferenceDrafts } = await import('../composer/linkedReferenceDrafts');
const { usePendingComposerReferences } = await import('../composer/pendingComposerReferences');
const { ChatColumnSessionContext, ChatColumnActionsContext } = await import('../chatColumnSession');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({ baseUrl: 'https://sync.test', fetch: async (request) => responseFor(request) });
const issue: Issue = {
  provider: 'github', instance: 'github.com', id: '7', number: 7,
  project: { id: 'repo', owner: 'acme', name: 'app', provider: 'github', instance: 'github.com', url: 'https://github.com/acme/app' },
  title: 'Captured issue', url: 'https://github.com/acme/app/issues/7', state: 'open',
};
const selection: ReferencePickerSelection = {
  source: 'repository', includeDiff: false,
  reference: {
    kind: 'issue', provider: 'github', number: 7, title: issue.title, url: issue.url, state: 'open',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null,
    labels: [], commentCount: 0, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  },
};
let readIssue = async (_number: number): Promise<Issue> => issue;
const changeRequestContext: ChangeRequestContext = {
  identity: { provider: context.provider, instance: context.instance },
  project: issue.project,
  changeRequest: {
    provider: context.provider, instance: context.instance, id: '7', number: 7,
    project: issue.project, title: 'Captured MR', url: 'https://github.com/acme/app/pull/7',
    state: 'open', draft: false, head: 'feature', base: 'main',
  },
  issueComments: [], reviewComments: [], files: [],
};
let readChangeRequest = async (_number: number): Promise<ChangeRequestContext> => changeRequestContext;
// SAFETY: Offline fixture implements the runtime capabilities these scenarios call.
const runtimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  sourceControl: { issueGet: (_context: SourceControlReadContext, number: number) => readIssue(number), issueComments: async () => [], changeRequestContext: (_context: SourceControlReadContext, number: number) => readChangeRequest(number) },
} as unknown as RuntimeAPIs;
const identity = (sessionId: string) => createChatDraftIdentity(getRuntimeKey(), DIRECTORY, sessionId);
const selectSession = (sessionId: string) => useSessionUIStore.setState({ currentSessionId: sessionId, currentSessionDirectory: DIRECTORY });

const withComposer = async (run: (container: HTMLElement) => Promise<void>, pinnedSessionId?: string) => {
  const originalSend = useSessionUIStore.getState().sendMessage;
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  // Admit the fixture folder before mount; the settings answer keeps it registered.
  useProjectsStore.setState({ projects: [{ id: 'project', path: DIRECTORY }] });
  useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false } });
  selectSession('session-a');
  useBtwStore.setState({ byParent: {} });
  useInputStore.setState({ pendingGuestIssue: null });
  useLinkedReferenceDrafts.setState({ drafts: new Map() });
  usePendingComposerReferences.setState({ pending: [] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}><ThemeSystemProvider><I18nProvider>
        <SyncProvider sdk={sdk} directory={DIRECTORY}>
          <ChatInput />
          {pinnedSessionId ? (
            <ChatColumnSessionContext.Provider value={{ sessionId: pinnedSessionId, directory: DIRECTORY }}>
              <ChatColumnActionsContext.Provider value={{ pinned: true, openSession: () => {}, openTimelineDialog: () => {}, focusInput: () => {} }}>
                <ChatInput />
              </ChatColumnActionsContext.Provider>
            </ChatColumnSessionContext.Provider>
          ) : null}
        </SyncProvider>
      </I18nProvider></ThemeSystemProvider></RuntimeAPIContext.Provider>,
    ));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    readIssue = async () => issue;
    readChangeRequest = async () => changeRequestContext;
    confirm = null;
    closePicker = null;
    useSessionUIStore.setState({ sendMessage: originalSend });
  }
};

afterAll(() => browser.close());

test('picker confirmation keeps its source draft when context resolves after A to B', async () => {
  await withComposer(async (container) => {
    let resolveIssue!: (issue: Issue) => void;
    const issueRead = new Promise<Issue>((resolve) => { resolveIssue = resolve; });
    readIssue = () => issueRead;
    const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open references');
    if (!open) throw new Error('Missing reference control');
    await act(async () => open.click());
    if (!confirm || !closePicker) throw new Error('Picker did not open');
    const pending = confirm([selection]);
    await act(async () => { closePicker?.(); selectSession('session-b'); });
    await act(async () => { resolveIssue(issue); expect(await pending).toBeNull(); });
    expect(readLinkedReferences(identity('session-a'))).toMatchObject([{ kind: 'repository-issue', number: 7 }]);
    expect(readLinkedReferences(identity('session-b'))).toEqual([]);
    // The item stands in its own draft's text as its link's chip, wherever the composer is now.
    expect(readChatDraft(identity('session-a')).text).toContain(issue.url);
    expect(readChatDraft(identity('session-b')).text).not.toContain(issue.url);
  });
});

test('reselecting an MR in a background draft preserves its portal link', async () => {
  await withComposer(async (container) => {
    const portal = 'https://portal.example.test/devops/change/300';
    const url = 'https://github.com/acme/app/pull/7';
    const target = identity('session-a');
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error('Missing composer');
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: portal }, userEvent: 'input.type' });
      useLinkedReferenceDrafts.getState().set([{
        kind: 'change-request', provider: 'github', number: 7, title: 'Previous MR', url,
        sourceLinks: [portal], contextText: 'previous context', head: '', base: '', includeDiff: false,
      }], target);
      writeChatDraft(target, portal, []);
    });
    let resolveContext!: (value: ChangeRequestContext) => void;
    const pendingContext = new Promise<ChangeRequestContext>((resolve) => { resolveContext = resolve; });
    readChangeRequest = () => pendingContext;
    const open = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open references');
    if (!open) throw new Error('Missing reference control');
    await act(async () => open.click());
    if (!confirm) throw new Error('Picker did not open');
    const pending = confirm([{
      ...selection, reference: {
        ...selection.reference, kind: 'pull', url, state: 'open', draft: false,
        head: 'feature', base: 'main', headSha: '', headRepo: null,
      },
    }]);
    await act(async () => selectSession('session-b'));
    await act(async () => { resolveContext(changeRequestContext); expect(await pending).toBeNull(); });
    expect(readLinkedReferences(target)).toMatchObject([{ url, title: 'Captured MR', sourceLinks: [portal] }]);
    expect(readChatDraft(target).text).toBe(portal);
  });
});

test('a pending guest waits through expanded btw and appears on the parent after collapse', async () => {
  await withComposer(async (container) => {
    await act(async () => useBtwStore.getState().setPanelState('session-a', { pending: true }));
    expect(container.querySelector('[data-btw-composer="true"]')).not.toBeNull();
    const guest = { providerId: 'extension', id: 'EXT-7', title: 'Deferred guest', url: 'https://example.com/7' };
    await act(async () => useInputStore.getState().setPendingGuestIssue(guest));
    expect(useInputStore.getState().pendingGuestIssue).toEqual(guest);
    expect(useLinkedReferenceDrafts.getState().drafts.size).toBe(0);
    await act(async () => useBtwStore.getState().setPanelState('session-a', { collapsed: true }));
    expect(useInputStore.getState().pendingGuestIssue).toBeNull();
    expect(readLinkedReferences(identity('session-a'))).toMatchObject([{ kind: 'guest', id: 'EXT-7' }]);
    expect(useLinkedReferenceDrafts.getState().drafts.size).toBe(1);
    expect(container.textContent).toContain(guest.title);
  });
});

test('a session handoff waits for the parent while btw owns the composer', async () => {
  await withComposer(async (container) => {
    await act(async () => useBtwStore.getState().setPanelState('session-a', { pending: true }));
    await act(async () => usePendingComposerReferences.getState().push([{
      kind: 'repository-issue', provider: 'github', number: 7, title: issue.title, url: issue.url, contextText: 'Context',
    }], { kind: 'session', sessionId: 'session-a' }));
    expect(usePendingComposerReferences.getState().pending).toHaveLength(1);
    expect(useLinkedReferenceDrafts.getState().drafts.size).toBe(0);
    await act(async () => useBtwStore.getState().setPanelState('session-a', { collapsed: true }));
    expect(usePendingComposerReferences.getState().pending).toHaveLength(0);
    expect(readLinkedReferences(identity('session-a'))).toMatchObject([{ kind: 'repository-issue', number: 7 }]);
    expect(container.textContent).toContain(issue.title);
  });
});

test('a handoff for A waits while B and a pinned A column are shown', async () => {
  await withComposer(async (container) => {
    await act(async () => selectSession('session-b'));
    await act(async () => usePendingComposerReferences.getState().push([{
      kind: 'repository-issue', provider: 'github', number: 7, title: issue.title, url: issue.url, contextText: 'Context',
    }], { kind: 'session', sessionId: 'session-a' }));
    expect(usePendingComposerReferences.getState().pending).toHaveLength(1);
    expect(readLinkedReferences(identity('session-a'))).toEqual([]);
    expect(readLinkedReferences(identity('session-b'))).toEqual([]);
    expect(container.textContent).not.toContain(issue.title);
    await act(async () => selectSession('session-a'));
    expect(usePendingComposerReferences.getState().pending).toHaveLength(0);
    expect(readLinkedReferences(identity('session-a'))).toMatchObject([{ kind: 'repository-issue', number: 7 }]);
    expect(readLinkedReferences(identity('session-b'))).toEqual([]);
  }, 'session-a');
});

test('a saved draft receives its pending handoff after reopening with a new numeric id', async () => {
  await withComposer(async (container) => {
    await act(async () => useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: DIRECTORY, workDraftId: 'work-a' }));
    const originalId = useSessionUIStore.getState().newSessionDraft.draftId;
    const target = { kind: 'draft' as const, workDraftId: 'work-a', runtimeKey: getRuntimeKey() };
    await act(async () => useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: DIRECTORY, workDraftId: 'work-b' }));
    await act(async () => usePendingComposerReferences.getState().push([{
      kind: 'repository-issue', number: 7, title: issue.title, url: issue.url, contextText: 'Delayed context',
    }], target));
    expect(container.textContent).not.toContain(issue.title);
    await act(async () => { await openSessionDraft({
      id: 'work-a', directory: DIRECTORY, projectId: null, text: 'Saved prompt', mentions: [], attachments: [],
      createdAt: 1, updatedAt: 1,
    }); });
    expect(useSessionUIStore.getState().newSessionDraft.draftId).not.toBe(originalId);
    expect(usePendingComposerReferences.getState().pending).toHaveLength(0);
    expect(container.textContent).toContain(issue.title);
  });
});

test('a failed first send retries with its references and chips attached during the request', async () => {
  await withComposer(async (container) => {
    await act(async () => useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: DIRECTORY, workDraftId: 'retry-work' }));
    await act(async () => useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model', isConnected: true, hasEverConnected: true }));
    const draftIdentity = identity('draft:retry-work');
    const reference = { kind: 'repository-issue' as const, number: 7, title: issue.title, url: issue.url, contextText: 'Original issue context' };
    await act(async () => useLinkedReferenceDrafts.getState().set([reference], draftIdentity));
    let rejectSend!: (error: Error) => void;
    const sending = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    const attempts: string[][] = [];
    useSessionUIStore.setState({ sendMessage: async (_text, _provider, _model, _agent, _files, _mention, parts) => {
      attempts.push((parts ?? []).map((part) => part.text));
      if (attempts.length === 1) return sending;
    } });
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    const form = container.querySelector('form');
    if (!view || !form) throw new Error('Missing composer');
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Fix this issue' }, userEvent: 'input.type' }));
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(attempts).toHaveLength(1);
    await act(async () => {
      useLinkedReferenceDrafts.getState().set([reference, { ...reference, number: 8, url: 'https://github.com/acme/app/issues/8', contextText: 'Draft addition' }], draftIdentity);
      useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false } });
      selectSession('created-session');
    });
    await act(async () => useLinkedReferenceDrafts.getState().set([
      { ...reference, number: 9, url: 'https://github.com/acme/app/issues/9', contextText: 'Session addition' },
    ], identity('created-session')));
    await act(async () => rejectSend(new DraftSendError('created-session', DIRECTORY, true, new Error('Failed to send message'))));
    expect(readLinkedReferences(draftIdentity)).toEqual([]);
    expect(readLinkedReferences(identity('created-session'))).toHaveLength(3);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(attempts).toHaveLength(2);
    expect(attempts[1].join('\n')).toContain('Original issue context');
    expect(attempts[1].join('\n')).toContain('Draft addition');
    expect(attempts[1].join('\n')).toContain('Session addition');
  });
});

test('only a paste converts a portal link, only to a change request, and a send converts nothing', async () => {
  const previousRegistry = useSourceControlProviderRegistry.getState();
  const { identities } = useSourceControlAuthStore.getState();
  const instance = 'https://forge.example.test';
  const alias = 'https://review.example.test';
  const descriptor = acmeDescriptor({ id: 'ext-portal', extension: { guestId: 'portal', name: 'Portal', version: '1.0.0' } });
  descriptor.urls.resolve = '/resolve';
  const provider = descriptor.id;
  const project = { ...issue.project, provider, instance, url: `${instance}/acme/app` };
  readContext = { ...context, provider, instance };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[provider, descriptor]]), status: 'ready', holdsList: true });
  useSourceControlAuthStore.setState({ identities: [{ provider, instance, instanceAliases: [alias] }] });
  try {
    await withComposer(async (container) => {
      await act(async () => useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model', isConnected: true, hasEverConnected: true }));
      const portal = (number: number) => `${alias}/review/${number}`;
      const converted: number[] = [];
      resolvePortalUrl = (url) => {
        const number = Number(url.split('/').at(-1));
        converted.push(number);
        const kind = number === 8 ? 'issues' : 'pulls';
        return Response.json({ status: 200, body: JSON.stringify({ url: `${instance}/acme/app/${kind}/${number}` }) });
      };
      const capturedChangeRequest = changeRequestContext.changeRequest;
      if (!capturedChangeRequest) throw new Error('Missing change request fixture');
      readChangeRequest = async (number) => ({
        ...changeRequestContext,
        identity: { provider, instance },
        project,
        changeRequest: { ...capturedChangeRequest, provider, instance, project, id: String(number), number, title: `Context ${number}`, url: `${instance}/acme/app/pulls/${number}` },
      });
      readIssue = async (number) => ({ ...issue, id: String(number), number, provider, instance, url: `${instance}/acme/app/issues/${number}`, title: `Context ${number}`, project });
      const attempts: string[][] = [];
      useSessionUIStore.setState({ sendMessage: async (_text, _provider, _model, _agent, _files, _mention, parts) => {
        attempts.push((parts ?? []).map((part) => part.text));
      } });
      const content = container.querySelector<HTMLElement>('.cm-content');
      const view = content ? EditorView.findFromDOM(content) : null;
      const form = container.querySelector('form');
      if (!view || !content || !form) throw new Error('Missing composer');
      const pasted = `${portal(7)} ${portal(8)}`;
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', pasted);
      await act(async () => {
        content.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        if (!view.state.doc.toString().includes(alias)) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pasted }, userEvent: 'input.paste' });
      });
      expect(converted.sort()).toEqual([7, 8]);
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: ` ${portal(9)}` }, userEvent: 'input.type' });
      });
      await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      expect(converted).toEqual([7, 8]);
      expect(attempts).toHaveLength(1);
      const sent = attempts[0].join('\n');
      expect(sent).toContain('Context 7');
      expect(sent).not.toContain('Context 8');
      expect(sent).not.toContain('Context 9');
    });
  } finally {
    resolvePortalUrl = undefined;
    readContext = context;
    useSourceControlProviderRegistry.setState(previousRegistry);
    useSourceControlAuthStore.setState({ identities });
  }
});

for (const answer of ['remap', 'none'] as const) {
  test(`pasting a restored portal link again replaces its old change request (${answer})`, async () => {
    const previousRegistry = useSourceControlProviderRegistry.getState();
    const { identities } = useSourceControlAuthStore.getState();
    const instance = 'https://forge.example.test';
    const alias = 'https://review.example.test';
    const descriptor = acmeDescriptor({ id: 'ext-portal', extension: { guestId: 'portal', name: 'Portal', version: '1.0.0' } });
    descriptor.urls.resolve = '/resolve';
    const provider = descriptor.id;
    const project = { ...issue.project, provider, instance, url: `${instance}/acme/app` };
    readContext = { ...context, provider, instance };
    useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[provider, descriptor]]), status: 'ready', holdsList: true });
    useSourceControlAuthStore.setState({ identities: [{ provider, instance, instanceAliases: [alias] }] });
    try {
      await withComposer(async (container) => {
        await act(async () => useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model', isConnected: true, hasEverConnected: true }));
        const portal = `${alias}/review/42`;
        resolvePortalUrl = () => Response.json({ status: 200, body: JSON.stringify(answer === 'remap' ? { url: `${instance}/acme/app/pulls/77` } : null) });
        const capturedChangeRequest = changeRequestContext.changeRequest;
        if (!capturedChangeRequest) throw new Error('Missing change request fixture');
        readChangeRequest = async (number) => ({
          ...changeRequestContext,
          identity: { provider, instance },
          project,
          changeRequest: { ...capturedChangeRequest, provider, instance, project, id: String(number), number, title: `Context ${number}`, url: `${instance}/acme/app/pulls/${number}` },
        });
        const attempts: string[][] = [];
        useSessionUIStore.setState({ sendMessage: async (_text, _provider, _model, _agent, _files, _mention, parts) => {
          attempts.push((parts ?? []).map((part) => part.text));
        } });
        const content = container.querySelector<HTMLElement>('.cm-content');
        const view = content ? EditorView.findFromDOM(content) : null;
        const form = container.querySelector('form');
        if (!view || !content || !form) throw new Error('Missing composer');
        await act(async () => {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `${portal} ` }, selection: { anchor: portal.length + 1 }, userEvent: 'input.type' });
          useLinkedReferenceDrafts.getState().set([{
            kind: 'change-request', provider, number: 42, title: 'Restored MR', url: `${instance}/acme/app/pulls/42`,
            sourceLinks: [portal], contextText: 'restored context 42', head: '', base: '', includeDiff: false,
          }], identity('session-a'));
        });
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', portal);
        await act(async () => {
          content.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        });
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        expect(attempts).toHaveLength(1);
        const sent = attempts[0].join('\n');
        expect(sent).not.toContain('restored context 42');
        if (answer === 'remap') expect(sent).toContain('Context 77');
        else expect(sent).not.toContain('Context 77');
      });
    } finally {
      resolvePortalUrl = undefined;
      readContext = context;
      useSourceControlProviderRegistry.setState(previousRegistry);
      useSourceControlAuthStore.setState({ identities });
    }
  });
}
