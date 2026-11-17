import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { LinearIssueStatesResult, LinearIssueSummary, LinearWorkflowState } from '@/lib/api/types';

/**
 * `issueStates` reports `statesMore` when a team holds more workflow states than
 * the one page fetched. The picker must not present that first page as the whole
 * list: this pins the disposition — a truncation note when the signal is set,
 * and no change to the picker when it is not.
 */

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

const TEAM_ID = 'team_1';
const issueStatesCalls: string[] = [];
let issueStatesResult: LinearIssueStatesResult = { connected: true, states: [] };

// Stable identity: the component's effect depends on `linear`, and a new object
// each render would re-fetch in a loop.
const runtimeAPIs = {
  linear: {
    issueStates: async (teamId: string) => {
      issueStatesCalls.push(teamId);
      return issueStatesResult;
    },
    // Only probed for presence; the picker becomes interactive when it exists.
    issueUpdate: async () => ({ connected: true, issue: null }),
  },
};

mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => runtimeAPIs }));
// The note is located by its i18n key; the key/translation parity is covered by
// the source-board i18n test.
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/references/ReferencePreview', () => ({
  StatePill: ({ label }: { label: string }) => React.createElement('span', null, label),
}));
mock.module('@/components/references/referencePickerItems', () => ({
  linearStateLook: () => ({ icon: 'circle', color: '#000000' }),
  linearStateTypeLook: () => ({ icon: 'circle', color: '#000000' }),
}));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, success: () => undefined } }));
// Radix opens on pointer events; the disposition under test is what the menu
// renders once the states arrive, so the menu shell is inert here.
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));

const { SourceBoardLinearStatus } = await import('./SourceBoardLinearStatus');

const issue: LinearIssueSummary = {
  id: 'issue_1',
  identifier: 'ENG-1',
  title: 'An issue with a status',
  url: 'https://linear.app/example/issue/ENG-1',
  state: { id: 'state_started', name: 'In Progress', type: 'started' },
  team: { id: TEAM_ID, key: 'ENG', name: 'Engineering' },
};

const states: LinearWorkflowState[] = [
  { id: 'state_backlog', name: 'Backlog', type: 'backlog', position: 1 },
  { id: 'state_started', name: 'In Progress', type: 'started', position: 2 },
];

const TRUNCATION_KEY = 'sourceBoard.linear.statesMore';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  issueStatesCalls.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const renderStatus = async (): Promise<void> => {
  await act(async () => {
    root.render(<SourceBoardLinearStatus issue={issue} onChanged={() => undefined} />);
  });
  // Let the effect's `issueStates` promise settle and the states render.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

test('a team with more states than one page shows the truncation note', async () => {
  issueStatesResult = { connected: true, states, statesMore: true };
  await renderStatus();

  expect(issueStatesCalls).toEqual([TEAM_ID]);
  expect(host.textContent).toContain(TRUNCATION_KEY);
  // The states that did arrive are still listed.
  expect(host.textContent).toContain('Backlog');
});

for (const statesMore of [false, undefined] as const) {
  test(`statesMore ${String(statesMore)} leaves the picker unchanged`, async () => {
    issueStatesResult = { connected: true, states, statesMore };
    await renderStatus();

    expect(issueStatesCalls).toEqual([TEAM_ID]);
    expect(host.textContent).not.toContain(TRUNCATION_KEY);
    expect(host.textContent).toContain('Backlog');
  });
}
