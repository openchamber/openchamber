/**
 * Moving Files to another zone must keep its editor, and with it any unsaved
 * edit. Each zone draws its own panel, so an editor rendered inside the zone
 * would remount on a move. These mount the real host and slots under
 * happy-dom with a stand-in editor that keeps its text in component state, the
 * way FilesView keeps a draft, and counts its mounts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://files-editor.test/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { FilesEditorHost, FilesEditorProvider, FilesEditorSlot } = await import('./FilesEditorHost');
const { useGuardFileLeave, useRegisterFileLeaveGuard } = await import('./filesEditorWorkspace');

type Zone = 'bottom' | 'left';

const container = document.createElement('div');
document.body.appendChild(container);
let root = createRoot(container);

afterEach(() => {
  act(() => root.unmount());
  root = createRoot(container);
});

let mounts = 0;
let typeInto: (text: string) => void = () => undefined;

/** Stands in for FilesView: an unsaved draft that lives only in its state. */
const DraftEditor: React.FC<{ visible: boolean }> = ({ visible }) => {
  const [draft, setDraft] = React.useState('original line');
  React.useEffect(() => {
    mounts += 1;
  }, []);
  typeInto = (text) => setDraft((current) => current + text);
  return <textarea data-editor="files" data-visible={String(visible)} value={draft} readOnly />;
};

/** Two zones, each its own subtree like a zone's panel, and the one host. */
const Workspace: React.FC<{ zone: Zone; mounted?: boolean; onEscape?: () => void }> = ({ zone, mounted = true, onEscape = () => undefined }) => (
  <I18nProvider>
    <FilesEditorProvider>
      <FilesEditorHost mounted={mounted} renderEditor={(visible) => <DraftEditor visible={visible} />} />
      {(['bottom', 'left'] as const).map((id) => (
        <section key={id} data-zone={id}>
          {zone === id ? (
            <FilesEditorSlot
              visible
              onKeyDownCapture={(event) => { if (event.key === 'Escape') onEscape(); }}
            />
          ) : null}
        </section>
      ))}
    </FilesEditorProvider>
  </I18nProvider>
);

const editor = () => container.querySelector<HTMLTextAreaElement>('[data-editor="files"]');
const zoneOfEditor = () => editor()?.closest('[data-zone]')?.getAttribute('data-zone') ?? null;

beforeEach(() => {
  mounts = 0;
});

test('moving Files to another zone keeps the same editor and its unsaved edit', () => {
  act(() => root.render(<Workspace zone="bottom" />));
  act(() => typeInto(' UNSAVED-EDIT'));
  const before = editor();

  act(() => root.render(<Workspace zone="left" />));

  expect(zoneOfEditor()).toBe('left');
  expect(editor()).toBe(before);
  expect(editor()?.value).toBe('original line UNSAVED-EDIT');
  expect(mounts).toBe(1);
});

test('the editor follows the zone back and forth without remounting', () => {
  act(() => root.render(<Workspace zone="bottom" />));
  act(() => typeInto(' A'));
  act(() => root.render(<Workspace zone="left" />));
  act(() => typeInto(' B'));
  act(() => root.render(<Workspace zone="bottom" />));

  expect(zoneOfEditor()).toBe('bottom');
  expect(editor()?.value).toBe('original line A B');
  expect(mounts).toBe(1);
});

test('the editor unmounts when Files has no open file, as closing the last file always did', () => {
  act(() => root.render(<Workspace zone="bottom" />));
  act(() => root.render(<Workspace zone="bottom" mounted={false} />));

  expect(editor()).toBeNull();
});

test("the zone's Escape handling still sees keys from the editor", () => {
  let escapes = 0;
  act(() => root.render(<Workspace zone="left" onEscape={() => { escapes += 1; }} />));

  act(() => {
    editor()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  expect(escapes).toBe(1);
});

test('a host that unmounts takes its node out of the slot it was in', () => {
  const Tree: React.FC<{ withHost: boolean }> = ({ withHost }) => (
    <I18nProvider>
      <FilesEditorProvider>
        {withHost ? <FilesEditorHost mounted renderEditor={(visible) => <DraftEditor visible={visible} />} /> : null}
        <section data-zone="bottom"><FilesEditorSlot visible onKeyDownCapture={() => undefined} /></section>
      </FilesEditorProvider>
    </I18nProvider>
  );
  act(() => root.render(<Tree withHost />));
  const slot = container.querySelector('[data-zone="bottom"] > div');
  expect(slot?.childElementCount).toBe(1);

  act(() => root.render(<Tree withHost={false} />));

  expect(container.querySelector('[data-zone="bottom"] > div')).toBe(slot);
  expect(slot?.childElementCount).toBe(0);
});

test('two workspaces keep separate editors', () => {
  const second = document.createElement('div');
  document.body.appendChild(second);
  const secondRoot = createRoot(second);
  act(() => root.render(<Workspace zone="bottom" />));
  act(() => secondRoot.render(<Workspace zone="left" />));

  expect(container.querySelectorAll('[data-editor="files"]')).toHaveLength(1);
  expect(second.querySelectorAll('[data-editor="files"]')).toHaveLength(1);
  expect(second.querySelector('[data-editor="files"]')?.closest('[data-zone]')?.getAttribute('data-zone')).toBe('left');

  act(() => secondRoot.unmount());
  second.remove();
});

// Leaving the loaded file goes through the editor's own save-or-discard
// check. The stand-in editor holds the navigation until "the user decides".
test('leaving an edited file waits for the editor; nothing is lost on the way', () => {
  let decide: (() => void) | null = null;
  let guardLeave: ((path: string, proceed: () => void) => void) | null = null;
  const GuardedEditor: React.FC = () => {
    useRegisterFileLeaveGuard(React.useCallback((path: string, proceed: () => void) => {
      if (path === '/repo/foo.ts') decide = proceed;
      else proceed();
    }, []));
    return null;
  };
  const Navigator: React.FC = () => {
    guardLeave = useGuardFileLeave();
    return null;
  };
  act(() => root.render(<FilesEditorProvider><GuardedEditor /><Navigator /></FilesEditorProvider>));

  let navigated = 0;
  act(() => guardLeave?.('/repo/foo.ts', () => { navigated += 1; }));
  expect(navigated).toBe(0);
  act(() => decide?.());
  expect(navigated).toBe(1);

  act(() => guardLeave?.('/repo/bar.ts', () => { navigated += 1; }));
  expect(navigated).toBe(2);
});

test('outside a workspace, or with no editor mounted, navigation runs at once', () => {
  let guardLeave: ((path: string, proceed: () => void) => void) | null = null;
  const Navigator: React.FC = () => {
    guardLeave = useGuardFileLeave();
    return null;
  };
  let navigated = 0;
  act(() => root.render(<Navigator />));
  act(() => guardLeave?.('/repo/foo.ts', () => { navigated += 1; }));
  act(() => root.render(<FilesEditorProvider><Navigator /></FilesEditorProvider>));
  act(() => guardLeave?.('/repo/foo.ts', () => { navigated += 1; }));

  expect(navigated).toBe(2);
});
