import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { DiffFindBar, type DiffFindBarProps } from './DiffFindBar';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLInputElement: browser.HTMLInputElement,
  KeyboardEvent: browser.KeyboardEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root;
let host: HTMLDivElement;
const calls: string[] = [];

const defaultProps: DiffFindBarProps = {
  query: '',
  onQueryChange: () => {},
  total: 0,
  currentIndex: 0,
  isSearching: false,
  onNext: () => calls.push('next'),
  onPrevious: () => calls.push('previous'),
  onClose: () => calls.push('close'),
};

const render = (props: Partial<DiffFindBarProps> = {}) => act(async () => {
  root.render(<I18nProvider><DiffFindBar {...defaultProps} {...props} /></I18nProvider>);
});

const pressKey = (key: string, shiftKey = false) => {
  const input = host.querySelector('input');
  if (!input) throw new Error('input not found');
  // `KeyboardEvent` is happy-dom's constructor here: the global is bound to it
  // at the top of the file, so the DOM typing lines up with the runtime object.
  return act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  calls.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('Enter moves to the next match, Shift+Enter to the previous one', async () => {
  await render();
  await pressKey('Enter');
  await pressKey('Enter', true);
  expect(calls).toEqual(['next', 'previous']);
});

test('Escape closes the bar', async () => {
  await render();
  await pressKey('Escape');
  expect(calls).toEqual(['close']);
});

test('shows the one-based position and the total as n/m', async () => {
  await render({ query: 'needle', total: 5, currentIndex: 2 });
  expect(host.textContent).toContain('3/5');
});

test('an empty query with no matches shows neither a count nor "No matches"', async () => {
  await render({ query: '', total: 0 });
  expect(host.textContent).not.toContain('0/0');
  expect(host.textContent).not.toContain('No matches');
});

test('a query with no matches says so and disables navigation', async () => {
  await render({ query: 'needle', total: 0 });
  expect(host.textContent).toContain('No matches');
  for (const button of host.querySelectorAll('button')) {
    if (button.getAttribute('aria-label') === 'Close search') continue;
    if (!(button instanceof HTMLButtonElement)) throw new Error('expected a button element');
    expect(button.disabled).toBe(true);
  }
});

test('navigation is enabled once there are matches', async () => {
  await render({ query: 'needle', total: 3, currentIndex: 0 });
  const previous = host.querySelector('button[aria-label="Previous match"]');
  const next = host.querySelector('button[aria-label="Next match"]');
  if (!(previous instanceof HTMLButtonElement)) throw new Error('previous button not found');
  if (!(next instanceof HTMLButtonElement)) throw new Error('next button not found');
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(false);
});

test('a still-reading changeset marks the total as growing', async () => {
  await render({ query: 'needle', total: 2, currentIndex: 0, isSearching: true });
  const count = host.querySelector('[aria-live="polite"]');
  expect(count?.textContent).toBe('1/2+');
  expect(count?.getAttribute('aria-label')).toBe('1 of 2, Still reading files…');
});

test('a finished search shows the final total', async () => {
  await render({ query: 'needle', total: 2, currentIndex: 0, isSearching: false });
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1/2');
});

test('a bumped focusNonce re-focuses and re-selects the query', async () => {
  await render({ query: 'needle', total: 1, currentIndex: 0, focusNonce: 0 });
  const input = host.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error('input not found');
  input.blur();
  input.setSelectionRange(3, 3);

  await render({ query: 'needle', total: 1, currentIndex: 0, focusNonce: 1 });
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe('needle'.length);
});

test('says how many files could not be searched, and nothing when all were', async () => {
  await render({ query: 'needle', total: 2, failedCount: 3 });
  expect(host.textContent).toContain("Files that couldn't be searched: 3");

  await render({ query: 'needle', total: 2, failedCount: 0 });
  expect(host.textContent).not.toContain("couldn't be searched");
});

test('does not say "No matches" while files are still being read', async () => {
  await render({ query: 'needle', total: 0, isSearching: true });
  expect(host.textContent).not.toContain('No matches');

  await render({ query: 'needle', total: 0, isSearching: false });
  expect(host.textContent).toContain('No matches');
});
