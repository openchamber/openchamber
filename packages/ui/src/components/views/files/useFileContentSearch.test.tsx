import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { FileContentSearchMatch, FileContentSearchOutcome, FileContentSearchQuery } from '@/lib/api/types';
import { useFileContentSearch, type FileContentSearchState } from './useFileContentSearch';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

type Deferred = {
  payload: FileContentSearchQuery;
  resolve: (outcome: FileContentSearchOutcome) => void;
  reject: (error: Error) => void;
};

let requests: Deferred[] = [];
const searchContents = (payload: FileContentSearchQuery) => new Promise<FileContentSearchOutcome>((resolve, reject) => {
  requests.push({ payload, resolve, reject });
});

type Props = Partial<Parameters<typeof useFileContentSearch>[0]>;
let states: FileContentSearchState[] = [];
let reactRoot: Root | null = null;

const Probe: React.FC<Props> = (props) => {
  const state = useFileContentSearch({
    searchContents,
    directory: '/repo',
    query: 'needle',
    regex: false,
    includeHidden: false,
    respectGitignore: true,
    active: true,
    ...props,
  });
  states.push(state);
  return null;
};

const render = async (props: Props = {}) => {
  if (!reactRoot) reactRoot = createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(<Probe {...props} />));
};

const settle = async () => act(async () => { await Promise.resolve(); });
const last = () => states[states.length - 1];

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  requests = [];
  states = [];
});

const match: FileContentSearchMatch = { path: '/repo/a.ts', relativePath: 'a.ts', line: 1, column: 1, text: 'needle', ranges: [[0, 6]], cutStart: false };

describe('useFileContentSearch', () => {
  test('searches with the options and reports the outcome', async () => {
    await render({ regex: true, includeHidden: true, respectGitignore: false });
    expect(last()).toEqual({ status: 'searching' });
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).toMatchObject({ directory: '/repo', query: 'needle', regex: true, limit: 200, includeHidden: true, respectGitignore: false });
    expect(requests[0].payload.signal).toBeInstanceOf(AbortSignal);

    requests[0].resolve({ status: 'ok', matches: [match], stopped: 'limit' });
    await settle();
    expect(last()).toEqual({ status: 'results', matches: [match], stopped: 'limit' });
  });

  test('stays idle without a query, a directory, an active surface or the capability', async () => {
    await render({ query: '   ' });
    await render({ directory: '' });
    await render({ active: false });
    await render({ searchContents: undefined });
    expect(requests).toHaveLength(0);
    expect(states.every((state) => state.status === 'idle')).toBe(true);
  });

  test('aborts the request a new query replaces and ignores its late answer', async () => {
    await render({ query: 'nee' });
    await render({ query: 'needle' });
    expect(requests).toHaveLength(2);
    expect(requests[0].payload.signal?.aborted).toBe(true);
    expect(requests[1].payload.signal?.aborted).toBe(false);

    requests[0].resolve({ status: 'ok', matches: [match], stopped: null });
    await settle();
    expect(last()).toEqual({ status: 'searching' });

    requests[1].resolve({ status: 'ok', matches: [], stopped: null });
    await settle();
    expect(last()).toEqual({ status: 'results', matches: [], stopped: null });
  });

  test('passes unavailable and invalid-pattern outcomes through and names other failures', async () => {
    await render();
    requests[0].resolve({ status: 'unavailable' });
    await settle();
    expect(last()).toEqual({ status: 'unavailable' });

    await render({ regex: true });
    requests[1].resolve({ status: 'invalid-pattern', message: 'unclosed group' });
    await settle();
    expect(last()).toEqual({ status: 'invalid-pattern', message: 'unclosed group' });

    await render({ query: 'other' });
    requests[2].reject(new Error('ripgrep exited with code 2'));
    await settle();
    expect(last()).toEqual({ status: 'failed', message: 'ripgrep exited with code 2' });
  });

  test('returns to idle and aborts when the surface goes inactive', async () => {
    await render();
    await render({ active: false });
    expect(requests[0].payload.signal?.aborted).toBe(true);
    expect(last()).toEqual({ status: 'idle' });
  });
});
