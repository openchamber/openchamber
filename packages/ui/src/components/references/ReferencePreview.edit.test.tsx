import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement, forwardRef, useImperativeHandle, useRef } from 'react';
import type { Root } from 'react-dom/client';

import type { RepositoryIssueReference, RepositoryReferenceComment, RepositoryReferenceDetail } from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import type { ReferenceCommentActions } from './ReferenceComments';
import type { ReferenceCommentItem } from './referenceTimeline';

// Item text renders through the chat's Markdown renderer, which reads the sync
// runtime; these tests are about the controls around the text.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => createElement('div', null, content),
}));

// The real editor is CodeMirror, which does not take typed text under
// happy-dom; these tests are about the controls around the text, so the field
// it draws is a textarea that reports the same changes and keys.
mock.module('@/components/chat/composer/editor/ComposerEditor', () => {
  interface Handle {
    focus: (options?: { preventScroll?: boolean }) => void;
    setSelection: (position: number) => void;
    getValue: () => string;
  }
  interface Props {
    value: string;
    onChange: (change: { value: string; selection: { start: number; end: number } }) => void;
    onKeyDown?: (event: KeyboardEvent) => boolean;
    editable?: boolean;
    placeholder?: string;
    'aria-label'?: string;
  }
  const ComposerEditor = forwardRef<Handle, Props>((props, ref) => {
    const field = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: (options) => field.current?.focus(options),
      setSelection: () => undefined,
      getValue: () => props.value,
    }), [props.value]);
    return createElement('textarea', {
      ref: field,
      value: props.value,
      placeholder: props.placeholder,
      'aria-label': props['aria-label'],
      disabled: props.editable === false,
      onChange: (event: { target: { value: string } }) => props.onChange({ value: event.target.value, selection: { start: 0, end: 0 } }),
      onKeyDown: (event: React.KeyboardEvent) => {
        if (props.onKeyDown?.(event.nativeEvent)) event.preventDefault();
      },
    });
  });
  return { ComposerEditor };
});

// The app's dialog is a portal under a focus trap; the tests answer it through
// the hook's own promise, so what they check is when the ask happens.
interface ConfirmState {
  requests: Array<{ title: string; message: string; action: string }>;
  answer: ((choice: boolean) => void) | null;
}
const confirmState: ConfirmState = { requests: [], answer: null };
mock.module('@/components/ui/confirm-dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: { title: string; message: string; action: string }) => {
      confirmState.requests.push(request);
      return new Promise<boolean>((resolve) => { confirmState.answer = resolve; });
    },
    dialog: null,
  }),
}));

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLImageElement: browser.HTMLImageElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  SVGElement: browser.SVGElement, sessionStorage: browser.sessionStorage,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The components' imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

// react-dom reads whether it runs in a browser when it loads, so it comes after the globals.
const { createRoot } = await import('react-dom/client');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  // The draft store outlives a render on purpose; each test starts without one.
  const { forgetReferenceTextDraft, referenceTextDraftKey } = await import('./referenceTextDrafts');
  forgetReferenceTextDraft(referenceTextDraftKey(issue));
});

const issue: RepositoryIssueReference = {
  kind: 'issue', provider: 'github', number: 7, title: 'Tidy the header', url: 'https://github.com/acme/app/issues/7',
  // Empty, so the preview draws no Markdown: the detail's own body seeds the editor.
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null,
  author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open',
};

const editableDetail = (overrides: Partial<RepositoryReferenceDetail> = {}): RepositoryReferenceDetail => ({
  number: 7, body: 'The whole description', viewerCanUpdate: true, comments: [], commentTotal: 0, pull: null, ...overrides,
});

type Features = SourceControlProviderDescriptor['features'];

/** The registry holds a GitHub host, with the given edit features turned on or off. */
const setProvider = async (features: Partial<Features> = {}) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const base = githubLikeDescriptor();
  const descriptor = { ...base, features: { ...base.features, ...features } };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type SaveText = (input: { title: string; body: string }) => Promise<void>;

const show = async (options: {
  reference?: RepositoryIssueReference;
  detail?: RepositoryReferenceDetail;
  onSaveText?: SaveText;
  comments?: RepositoryReferenceComment[];
  commentActions?: ReferenceCommentActions;
} = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  const apis = createWebAPIs();
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <ReferencePreview
            item={{ source: 'repository', reference: options.reference ?? issue }}
            directory={null}
            pullStatus={{ status: 'idle' }}
            trackerDetail={{ status: 'idle' }}
            repositoryDetail={{ status: 'ready', value: options.comments ? editableDetail({ comments: options.comments, commentTotal: options.comments.length }) : options.detail ?? editableDetail() }}
            purpose="attach"
            pinned={false}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={0}
            onRefresh={async () => undefined}
            onSaveText={options.onSaveText}
            commentActions={options.commentActions}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

const pencil = () => host.querySelector<HTMLButtonElement>('button[aria-label="Edit title and description"]');
const titleField = () => host.querySelector<HTMLInputElement>('input[aria-label="Title"]');
const bodyField = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');
const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);

const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
};

const typeInto = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = async (element: Element, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
};

describe('an unsaved edit when the item is left', () => {
  test('comes back when the editor opens again, and Escape drops it', async () => {
    await setProvider();
    await show({ onSaveText: async () => undefined });
    await click(pencil());
    await typeInto(titleField()!, 'Half-typed title');
    // The board remounts the preview per item: leaving and coming back is a new mount.
    await act(async () => root.unmount());
    root = createRoot(host);
    await show({ onSaveText: async () => undefined });
    await click(pencil());
    expect(titleField()?.value).toBe('Half-typed title');
    await press(titleField()!, 'Escape');
    await click(pencil());
    expect(titleField()?.value).toBe('Tidy the header');
  });
});

describe('editing the previewed item in place', () => {
  test('no pencil where the surface offers no save', async () => {
    await setProvider();
    await show();
    expect(pencil()).toBeNull();
  });

  test('the pencil opens an editor seeded from the item and the detail, and Escape leaves it', async () => {
    let saves = 0;
    await setProvider();
    await show({ onSaveText: async () => { saves += 1; } });

    await click(pencil());
    expect(titleField()?.value).toBe('Tidy the header');
    expect(bodyField()?.value).toBe('The whole description');
    // The title takes the caret at the end, so typing continues it.
    expect(document.activeElement).toBe(titleField());
    expect(titleField()?.selectionStart).toBe('Tidy the header'.length);
    // Nothing changed yet.
    expect(buttonNamed('Save')?.disabled).toBe(true);

    await press(titleField()!, 'Escape');
    expect(bodyField()).toBeNull();
    expect(saves).toBe(0);
  });

  test('save sends the trimmed title and the body, then closes the editor', async () => {
    const sent: Array<{ title: string; body: string }> = [];
    await setProvider();
    await show({ onSaveText: async (input) => { sent.push(input); } });

    await click(pencil());
    await typeInto(titleField()!, '  Tidy the header now  ');
    await typeInto(bodyField()!, 'A new description');
    expect(buttonNamed('Save')?.disabled).toBe(false);

    await click(buttonNamed('Save'));
    expect(sent).toEqual([{ title: 'Tidy the header now', body: 'A new description' }]);
    expect(bodyField()).toBeNull();
    expect(titleField()).toBeNull();
  });

  test('Ctrl+Enter saves without leaving the field', async () => {
    const sent: string[] = [];
    await setProvider();
    await show({ onSaveText: async ({ title }) => { sent.push(title); } });

    await click(pencil());
    await typeInto(bodyField()!, 'Only the description changed');
    await press(bodyField()!, 'Enter', { ctrlKey: true });

    expect(sent).toEqual(['Tidy the header']);
    expect(bodyField()).toBeNull();
  });

  test('Enter in the one-line title saves, as it would in any other field', async () => {
    const sent: string[] = [];
    await setProvider();
    await show({ onSaveText: async ({ title }) => { sent.push(title); } });

    await click(pencil());
    await typeInto(titleField()!, 'A title saved with Enter');
    await press(titleField()!, 'Enter');

    expect(sent).toEqual(['A title saved with Enter']);
    expect(titleField()).toBeNull();
  });

  test('Enter in the description is a new line, not a save', async () => {
    let saves = 0;
    await setProvider();
    await show({ onSaveText: async () => { saves += 1; } });

    await click(pencil());
    await typeInto(bodyField()!, 'A first line');
    await press(bodyField()!, 'Enter');

    expect(saves).toBe(0);
    expect(bodyField()).not.toBeNull();
  });

  test('a rejected save keeps the editor open with what was written', async () => {
    await setProvider();
    await show({ onSaveText: async () => { throw new Error('GitHub refused the edit'); } });

    await click(pencil());
    await typeInto(titleField()!, 'Another title');
    await click(buttonNamed('Save'));

    expect(titleField()?.value).toBe('Another title');
    expect(bodyField()?.value).toBe('The whole description');
    expect(buttonNamed('Save')?.disabled).toBe(false);
  });

  test('a save in flight cannot be started twice', async () => {
    const sent: string[] = [];
    let finish: () => void = () => undefined;
    await setProvider();
    await show({
      onSaveText: async ({ title }) => {
        sent.push(title);
        await new Promise<void>((resolve) => { finish = resolve; });
      },
    });

    await click(pencil());
    await typeInto(titleField()!, 'Once only');
    await act(async () => {
      buttonNamed('Save')?.click();
      buttonNamed('Save')?.click();
    });
    expect(sent).toEqual(['Once only']);

    await act(async () => { finish(); });
    expect(bodyField()).toBeNull();
  });

  test('a linked item, a host without the edit or an account that may not update it gets no pencil', async () => {
    await setProvider();
    await show({ reference: { ...issue, linked: true }, onSaveText: async () => undefined });
    expect(pencil()).toBeNull();

    await setProvider({ issueEdit: false });
    await show({ onSaveText: async () => undefined });
    expect(pencil()).toBeNull();

    await setProvider();
    await show({ detail: editableDetail({ viewerCanUpdate: false }), onSaveText: async () => undefined });
    expect(pencil()).toBeNull();
  });

  test('a cut list body is editable only once the detail brings the whole body', async () => {
    await setProvider();
    await show({
      reference: { ...issue, bodyTruncated: true },
      detail: editableDetail({ body: undefined }),
      onSaveText: async () => undefined,
    });
    expect(pencil()).toBeNull();

    await show({
      reference: { ...issue, bodyTruncated: true },
      detail: editableDetail(),
      onSaveText: async () => undefined,
    });
    expect(pencil()).not.toBeNull();
  });
});

const note = (overrides: Partial<RepositoryReferenceComment> = {}): RepositoryReferenceComment => ({
  author: { login: 'ada' }, body: 'The first note', createdAt: null, url: 'https://github.com/acme/app/issues/7#c1',
  id: 'c1', canUpdate: true, canDelete: true, path: null, line: null, review: null, ...overrides,
});

const commentMenu = () => host.querySelector<HTMLButtonElement>('button[aria-label="Comment actions"]');
const commentField = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit"]');
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
/** The icon each item leads with, by its sprite name. */
const menuItemIcons = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .map((item) => item.querySelector('use')?.getAttribute('href') ?? '');

const openCommentMenu = async () => {
  if (!commentMenu()) throw new Error('Expected the comment menu');
  await click(commentMenu());
  return menuItems();
};

const clickMenuItem = async (label: string) => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === label);
  if (!item) throw new Error(`Expected ${label}`);
  await act(async () => { item.click(); });
};

/** Answers the pending confirmation, then lets the removal that follows run. */
const answerConfirm = async (choice: boolean) => {
  await act(async () => {
    confirmState.answer?.(choice);
    confirmState.answer = null;
  });
};

const recordingActions = () => {
  const updates: Array<{ id: string | undefined; body: string }> = [];
  const removals: Array<string | undefined> = [];
  const actions = (overrides: Partial<ReferenceCommentActions> = {}): ReferenceCommentActions => ({
    update: async (comment: ReferenceCommentItem, body: string) => { updates.push({ id: comment.id, body }); },
    remove: async (comment: ReferenceCommentItem) => { removals.push(comment.id); },
    ...overrides,
  });
  return { updates, removals, actions };
};

describe('editing and deleting a previewed conversation comment', () => {
  test('no menu where the surface offers no comment actions', async () => {
    await setProvider();
    await show({ comments: [note()] });
    expect(commentMenu()).toBeNull();
  });

  test('a comment this account may not update still offers Delete', async () => {
    await setProvider();
    await show({ comments: [note({ canUpdate: false })], commentActions: recordingActions().actions() });

    const items = await openCommentMenu();
    expect(items).toEqual(['Delete']);
    expect(menuItemIcons()).toEqual(['#oc-delete-bin']);
  });

  test('each action leads with its own icon', async () => {
    await setProvider();
    await show({ comments: [note()], commentActions: recordingActions().actions() });

    expect(await openCommentMenu()).toEqual(['Edit', 'Delete']);
    expect(menuItemIcons()).toEqual(['#oc-edit', '#oc-delete-bin']);
  });

  test('a half-typed rewrite survives leaving the item, and Escape drops it', async () => {
    const { actions } = recordingActions();
    await setProvider();
    await show({ comments: [note()], commentActions: actions() });
    await openCommentMenu();
    await clickMenuItem('Edit');
    await typeInto(commentField()!, 'Half a rewri');

    await act(async () => root.unmount());
    root = createRoot(host);
    await show({ comments: [note()], commentActions: actions() });
    await openCommentMenu();
    await clickMenuItem('Edit');
    expect(commentField()?.value).toBe('Half a rewri');

    await press(commentField()!, 'Escape');
    expect(commentField()).toBeNull();
    await openCommentMenu();
    await clickMenuItem('Edit');
    expect(commentField()?.value).toBe('The first note');
  });

  test('a comment neither updated nor deleted gets no menu', async () => {
    await setProvider();
    await show({ comments: [note({ canUpdate: false, canDelete: false })], commentActions: recordingActions().actions() });
    expect(commentMenu()).toBeNull();
  });

  test('editing seeds the comment and saves its trimmed text with that comment id', async () => {
    const { updates, actions } = recordingActions();
    await setProvider();
    await show({ comments: [note()], commentActions: actions() });

    await openCommentMenu();
    await clickMenuItem('Edit');
    expect(commentField()?.value).toBe('The first note');
    expect(buttonNamed('Save')?.disabled).toBe(true);

    await typeInto(commentField()!, '  The first note, revised  ');
    expect(buttonNamed('Save')?.disabled).toBe(false);
    await click(buttonNamed('Save'));

    expect(updates).toEqual([{ id: 'c1', body: 'The first note, revised' }]);
    expect(commentField()).toBeNull();
  });

  test('Escape leaves the editor without writing', async () => {
    const { updates, actions } = recordingActions();
    await setProvider();
    await show({ comments: [note()], commentActions: actions() });

    await openCommentMenu();
    await clickMenuItem('Edit');
    await typeInto(commentField()!, 'A change nobody keeps');
    await press(commentField()!, 'Escape');

    expect(commentField()).toBeNull();
    expect(updates).toEqual([]);
  });

  test('a rejected save keeps the editor open with what was written', async () => {
    const { actions } = recordingActions();
    await setProvider();
    await show({
      comments: [note()],
      commentActions: actions({ update: async () => { throw new Error('GitHub refused the comment'); } }),
    });

    await openCommentMenu();
    await clickMenuItem('Edit');
    await typeInto(commentField()!, 'Still not saved');
    await click(buttonNamed('Save'));

    expect(commentField()?.value).toBe('Still not saved');
    expect(buttonNamed('Save')?.disabled).toBe(false);
  });

  test('delete asks first, and only a yes removes the comment', async () => {
    const { removals, actions } = recordingActions();
    confirmState.requests = [];
    await setProvider();
    await show({ comments: [note()], commentActions: actions() });

    await openCommentMenu();
    await clickMenuItem('Delete');
    expect(confirmState.requests).toMatchObject([{ title: 'Delete this comment?', action: 'Delete comment', destructive: true }]);
    expect(confirmState.requests[0]?.message).toContain('comment');
    expect(removals).toEqual([]);

    await answerConfirm(true);
    expect(removals).toEqual(['c1']);
  });

  test('a decline removes nothing', async () => {
    const { removals, actions } = recordingActions();
    await setProvider();
    await show({ comments: [note()], commentActions: actions() });

    await openCommentMenu();
    await clickMenuItem('Delete');
    await answerConfirm(false);
    expect(removals).toEqual([]);
  });
});
