import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createWebAPIs } from '../../../../web/src/api/index';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useTrackerRegistry } from '@/lib/trackers/registry';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSourceBoardStore } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { isSameRepositoryItemLink, trackerItemLabel, trackerTargetOfUrl, useOpenTrackerItem } from './openTrackerItem';

const urls = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor()], []);
const trackers = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);
const noTrackers = createTrackerUrlMatcher([]);

test('Linear links open the board only with an available connected integration', async () => {
  const browser = new Window({ url: 'http://localhost' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const originals = {
    registry: useTrackerRegistry.getState(), auth: useTrackerAuthStore.getState(),
    directory: useDirectoryStore.getState(), board: useSourceBoardStore.getState(),
    ui: useUIStore.getState(), session: useSessionUIStore.getState(),
  };
  const external: string[] = [];
  browser.open = (url) => { external.push(String(url)); return null; };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const url = 'https://linear.app/openchamber/issue/OPE-282/some-title';
  function Link() {
    const open = useOpenTrackerItem();
    return React.createElement('button', { onClick: () => open(url, '/repo') }, 'Open issue');
  }
  const apis = createWebAPIs();
  try {
    const linear = linearLikeTrackerDescriptor();
    useTrackerRegistry.setState({ ordered: [linear], byId: new Map([[linear.id, linear]]) });
    useDirectoryStore.setState({ currentDirectory: '' });
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...originals.session.newSessionDraft, open: false } });
    for (const [available, connected] of [[true, true], [true, false], [false, true]] as const) {
      external.length = 0;
      useTrackerAuthStore.getState().setStatus('linear', connected ? {
        connected: true, account: { id: 'account', name: 'Test', current: true },
      } : { connected: false });
      useSourceBoardStore.getState().clearTrackerFocus();
      useUIStore.getState().setSourceBoardOpen(false);
      await act(async () => root.render(React.createElement(RuntimeAPIContext.Provider, {
        value: available ? apis : { ...apis, trackers: undefined },
      }, React.createElement(Link))));
      await act(async () => host.querySelector('button')?.click());
      if (available && connected) {
        expect(external).toEqual([]);
        expect(useSourceBoardStore.getState().trackerFocus).toEqual({ provider: 'linear', identifier: 'OPE-282' });
        expect(useUIStore.getState().isSourceBoardOpen).toBe(true);
      } else {
        expect(external).toEqual([url]);
        expect(useSourceBoardStore.getState().trackerFocus).toBeNull();
        expect(useUIStore.getState().isSourceBoardOpen).toBe(false);
      }
    }
  } finally {
    await act(async () => root.unmount());
    useTrackerRegistry.setState(originals.registry, true);
    useTrackerAuthStore.setState(originals.auth, true);
    useDirectoryStore.setState(originals.directory, true);
    useSourceBoardStore.setState(originals.board, true);
    useUIStore.setState(originals.ui, true);
    useSessionUIStore.setState(originals.session, true);
    await browser.happyDOM.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

describe('trackerTargetOfUrl', () => {
  test('names what a link opens as', () => {
    expect(trackerTargetOfUrl('https://github.com/openchamber/openchamber/pull/4500', urls, trackers)).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerTargetOfUrl('https://github.com/openchamber/openchamber/issues/4483', urls, trackers)).toEqual({ source: 'repository', kind: 'issue' });
    expect(trackerTargetOfUrl('https://gitlab.com/group/sub/app/-/merge_requests/7', urls, trackers)).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerTargetOfUrl('https://gitlab.com/group/sub/app/-/issues/3', urls, trackers)).toEqual({ source: 'repository', kind: 'issue' });
    expect(trackerTargetOfUrl('https://linear.app/openchamber/issue/ope-282/some-title', urls, trackers)).toEqual({ source: 'tracker', provider: 'linear', identifier: 'OPE-282' });
  });

  test('leaves anything else to the browser', () => {
    expect(trackerTargetOfUrl('#12', urls, trackers)).toBeNull();
    expect(trackerTargetOfUrl('https://example.com/tickets/12', urls, trackers)).toBeNull();
    expect(trackerTargetOfUrl('https://github.com/openchamber/openchamber', urls, trackers)).toBeNull();
  });
});

describe('isSameRepositoryItemLink', () => {
  test('matches the item a link names, whatever page of it the link opens', () => {
    const pull = 'https://github.com/BendingSpoons/athena/pull/2553';
    expect(isSameRepositoryItemLink(pull, 'https://github.com/bendingspoons/athena/pull/2553/files', urls)).toBe(true);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/BendingSpoons/athena/issues/2553', urls)).toBe(true);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/BendingSpoons/athena/pull/2566', urls)).toBe(false);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/other/athena/pull/2553', urls)).toBe(false);
  });

  test('tells GitLab issues and merge requests apart', () => {
    const request = 'https://gitlab.com/group/app/-/merge_requests/7';
    expect(isSameRepositoryItemLink(request, 'https://gitlab.com/group/app/-/merge_requests/7/diffs', urls)).toBe(true);
    expect(isSameRepositoryItemLink(request, 'https://gitlab.com/group/app/-/issues/7', urls)).toBe(false);
    expect(isSameRepositoryItemLink('#7', '#7', urls)).toBe(false);
  });
});

describe('trackerItemLabel', () => {
  test('names a tab the way its host numbers the item', () => {
    expect(trackerItemLabel('https://github.com/openchamber/openchamber/pull/4500/files', urls, trackers)).toBe('#4500');
    expect(trackerItemLabel('https://gitlab.com/group/app/-/merge_requests/7', urls, trackers)).toBe('!7');
    expect(trackerItemLabel('https://gitlab.com/group/app/-/issues/7', urls, trackers)).toBe('#7');
    expect(trackerItemLabel('https://linear.app/openchamber/issue/ope-282/some-title', urls, trackers)).toBe('OPE-282');
    expect(trackerItemLabel('https://example.com/tickets/12', urls, trackers)).toBeNull();
  });
});

describe('tracker links', () => {
  test('a tracker link is the tracker\'s only while the server serves that tracker', () => {
    const link = 'https://linear.app/openchamber/issue/ope-282/some-title';
    expect(trackerTargetOfUrl(link, urls, noTrackers)).toBeNull();
    expect(trackerItemLabel(link, urls, noTrackers)).toBeNull();
  });

  test('a tracker the UI has no code for opens and labels through its served patterns', () => {
    const acme = createTrackerUrlMatcher([linearLikeTrackerDescriptor(), acmeTrackerDescriptor()]);
    expect(trackerTargetOfUrl('https://tickets.example.com/t/OPS-7', urls, acme)).toEqual({ source: 'tracker', provider: 'acme-tickets', identifier: 'OPS-7' });
    expect(trackerItemLabel('https://tickets.example.com/t/OPS-7', urls, acme)).toBe('OPS-7');
  });
});

describe('a provider the UI has no code for', () => {
  const acme = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor(), acmeDescriptor()], []);

  test('opens, labels and compares its links through its own patterns', () => {
    const link = 'https://forge.example.com/team/tool/pulls/9';
    expect(trackerTargetOfUrl(link, acme, trackers)).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerItemLabel(link, acme, trackers)).toBe('#9');
    expect(isSameRepositoryItemLink(link, 'https://forge.example.com/Team/Tool/pulls/9/files', acme)).toBe(true);
    // Without its descriptor the link is nobody's.
    expect(trackerTargetOfUrl(link, urls, trackers)).toBeNull();
  });
});
