import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useRemoteBranchSearch } from './useRemoteBranchSearch';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Probe: React.FC<{
  query: string;
  search: (query: string) => Promise<string[]>;
  enabled?: boolean;
}> = ({ query, search, enabled = true }) => {
  const result = useRemoteBranchSearch({ enabled, query, search });
  return (
    <span
      data-value={result.matches[0] ?? ''}
      data-searching={String(result.isSearching)}
      data-failed={String(result.failed)}
    />
  );
};

const searchState = () => ({
  value: host.querySelector('[data-value]')?.getAttribute('data-value') ?? '',
  searching: host.querySelector('[data-searching]')?.getAttribute('data-searching') === 'true',
  failed: host.querySelector('[data-failed]')?.getAttribute('data-failed') === 'true',
});

const render = (element: React.ReactElement) => act(async () => root?.render(element));
const advance = (milliseconds: number) => act(async () => {
  jest.advanceTimersByTime(milliseconds);
});

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  jest.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  jest.useRealTimers();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test('waits for the debounce before asking, then publishes the matches', async () => {
  const searches: string[] = [];
  const search = async (query: string) => {
    searches.push(query);
    return [`origin/${query}`];
  };

  await render(<Probe query="" search={search} />);
  await render(<Probe query="remote" search={search} />);
  expect(searches).toEqual([]);
  expect(searchState().searching).toBe(true);

  await advance(150);
  expect(searches).toEqual([]);

  await advance(100);
  expect(searches).toEqual(['remote']);
  expect(searchState()).toEqual({ value: 'origin/remote', searching: false, failed: false });
});

test('reports a failed lookup instead of an empty answer', async () => {
  const search = async (): Promise<string[]> => {
    throw new Error('unavailable');
  };

  await render(<Probe query="" search={search} />);
  await render(<Probe query="remote" search={search} />);
  await advance(250);

  expect(searchState()).toEqual({ value: '', searching: false, failed: true });
});

test('answers a repeated query from its cache', async () => {
  let calls = 0;
  const search = async (query: string) => {
    calls += 1;
    return [`origin/${query}`];
  };

  await render(<Probe query="first" search={search} />);
  await advance(250);
  await render(<Probe query="second" search={search} />);
  await advance(250);
  await render(<Probe query="first" search={search} />);
  await advance(250);

  expect(calls).toBe(2);
  expect(searchState().value).toBe('origin/first');
});

test('does not ask when the lookup is disabled', async () => {
  const searches: string[] = [];
  const search = async (query: string) => {
    searches.push(query);
    return [`origin/${query}`];
  };

  await render(<Probe query="remote" search={search} enabled={false} />);
  await advance(500);

  expect(searches).toEqual([]);
  expect(searchState().value).toBe('');
});
