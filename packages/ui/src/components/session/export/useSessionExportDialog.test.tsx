/**
 * The export dialog's own state.
 *
 * The dialog is a controlled component: the hook holds the format, the
 * detail level and the sub-agent count, and the dialog only reports what the
 * user picked. These tests read that state, because the count and the
 * format are the two things the Header and the Sidebar have to agree on.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  localStorage: browser.localStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

const { I18nProvider } = await import('@/lib/i18n');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionExportDialog } = await import('./useSessionExportDialog');

afterAll(() => {
  browser.close();
});

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

const resetSessions = (hasLoaded = true) => {
  useGlobalSessionsStore.setState({
    activeSessions: [],
    archivedSessions: [],
    sessionsByDirectory: new Map(),
    entityById: new Map(),
    structure: {
      activeSessionIds: [],
      activeRootIds: [],
      activeChildrenByParentId: new Map(),
      activeIdsByDirectory: new Map(),
    },
    hasLoaded,
    status: hasLoaded ? 'ready' : 'loading',
  });
};

/** Puts the given sessions into the store, the way the app holds them. */
const setSessions = (sessions: Session[], hasLoaded = true) => {
  resetSessions(hasLoaded);
  useGlobalSessionsStore.getState().upsertSessions(sessions);
};

/**
 * Renders the dialog hook and hands back the element it produced, so the
 * test can open it and read what it shows.
 */
const renderHook = async (): Promise<{
  open: (sessionID: string) => Promise<void>;
  text: () => string;
  click: (label: string) => Promise<void>;
  uncheck: () => Promise<void>;
  confirm: () => Promise<void>;
  chosen: Array<{ format: string; mode: string; includeSubagents: boolean }>;
}> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const chosen: Array<{ format: string; mode: string; includeSubagents: boolean }> = [];
  let open: (sessionID: string) => void = () => {};

  const Harness = () => {
    const dialog = useSessionExportDialog((_target, choice) => { chosen.push(choice); });
    open = (sessionID: string) => dialog.openDialog({
      sessionID,
      title: 'Session',
      directory: '/repo',
    });
    return <I18nProvider>{dialog.dialog}</I18nProvider>;
  };

  await act(async () => {
    root.render(<Harness />);
  });

  // A choice is picked by what it says: a radio's own button carries no
  // text, so the label beside it names it.
  const click = async (label: string) => {
    const target = [...container.querySelectorAll<HTMLElement>('button, label')].find((candidate) => {
      const text = candidate.textContent?.trim() ?? '';
      return text === label || candidate.getAttribute('aria-label') === label;
    });
    expect(target).toBeTruthy();
    await act(async () => {
      target?.click();
    });
  };

  return {
    open: async (sessionID: string) => {
      await act(async () => { open(sessionID); });
    },
    text: () => container.textContent ?? '',
    click,
    // The sub-agent switch is a checkbox, and the reader turns it off by
    // clicking it.
    uncheck: async () => {
      const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(box).toBeTruthy();
      await act(async () => {
        box?.click();
      });
    },
    confirm: () => click('Export'),
    chosen,
  };
};

describe('useSessionExportDialog', () => {
  test('a session with sub-agent sessions offers them, counted from the app\'s tree', async () => {
    setSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root' }),
    ]);

    const dialog = await renderHook();
    await dialog.open('ses_root');

    expect(dialog.text()).toContain('Include sub-agent tasks');
    expect(dialog.text()).toContain('1 sub-agent session');
  });

  test('the count is the number of the sessions the app attaches', async () => {
    // The count comes from the tree the sidebar shows: the sessions whose
    // parent is this one, and their own children in turn. A session the app
    // does not attach — a dispatched one, which has no parent — is not part
    // of it.
    setSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      session('ses_grand', { title: 'Grand', parentID: 'ses_child' }),
      session('ses_dispatched', { title: 'Dispatched' }),
    ]);

    const dialog = await renderHook();
    await dialog.open('ses_root');

    expect(dialog.text()).toContain('2 sub-agent sessions');
  });

  test('a session without sub-agent sessions does not offer them', async () => {
    setSessions([session('ses_root', { title: 'Root' })]);

    const dialog = await renderHook();
    await dialog.open('ses_root');

    expect(dialog.text()).not.toContain('Include sub-agent tasks');
  });

  test('a session without sub-agent sessions still covers the lineage', async () => {
    // The list names no sub-agent session, so the dialog offers no switch
    // and the reader expresses no choice. The coverage stays on.
    setSessions([session('ses_root', { title: 'Root' })]);

    const dialog = await renderHook();
    await dialog.open('ses_root');
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(1);
    expect(dialog.chosen[0].includeSubagents).toBe(true);
  });

  test('turning the sub-agent tasks off is the reader\'s own choice', async () => {
    setSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root' }),
    ]);

    const dialog = await renderHook();
    await dialog.open('ses_root');
    await dialog.uncheck();
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(1);
    expect(dialog.chosen[0].includeSubagents).toBe(false);
  });

  test('the coverage the reader chose stays with its session', async () => {
    // The format and the detail level survive a closing, and so does the
    // coverage: the choice belongs to the session the reader made it for.
    setSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      session('ses_other', { title: 'Other' }),
    ]);

    const dialog = await renderHook();
    await dialog.open('ses_root');
    await dialog.uncheck();
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(1);
    expect(dialog.chosen[0].includeSubagents).toBe(false);

    // The same session keeps the choice when the dialog opens again.
    await dialog.open('ses_root');
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(2);
    expect(dialog.chosen[1].includeSubagents).toBe(false);

    // Another session's sub-agent tasks are its own, so the choice does not
    // reach it.
    await dialog.open('ses_other');
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(3);
    expect(dialog.chosen[2].includeSubagents).toBe(true);
  });

  test('a session list that is still loading says the coverage is unknown', async () => {
    // The list arrives in pages, and it is the only place the lineage
    // lives. A count taken from a partial list would name a number the
    // document does not carry, so the dialog says the count is unknown.
    setSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root' }),
    ], false);

    const dialog = await renderHook();
    await dialog.open('ses_root');

    expect(dialog.text()).toContain('The number of sub-agent sessions is not known yet');
    expect(dialog.text()).not.toContain('1 sub-agent session');
    expect(dialog.text()).toContain('Check again');
  });

  test('checking again counts the sub-agent tasks once the list is complete', async () => {
    setSessions([
      session('ses_root', { title: 'Root' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root' }),
    ], false);

    const dialog = await renderHook();
    await dialog.open('ses_root');

    // The list finished loading between the two looks at it.
    useGlobalSessionsStore.setState({ hasLoaded: true });
    await dialog.click('Check again');

    expect(dialog.text()).toContain('1 sub-agent session');
    expect(dialog.text()).toContain('Include sub-agent tasks');
  });

  test('the format and the detail level survive a closing', async () => {
    setSessions([session('ses_root', { title: 'Root' })]);

    const dialog = await renderHook();
    await dialog.open('ses_root');

    await dialog.click('HTML');
    await dialog.click('Full details');
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(1);
    expect(dialog.chosen[0].format).toBe('html');
    expect(dialog.chosen[0].mode).toBe('detailed');

    // A second export keeps the shape the user picked the first time.
    await dialog.open('ses_root');
    await dialog.confirm();

    expect(dialog.chosen).toHaveLength(2);
    expect(dialog.chosen[1].format).toBe('html');
    expect(dialog.chosen[1].mode).toBe('detailed');
  });
});
