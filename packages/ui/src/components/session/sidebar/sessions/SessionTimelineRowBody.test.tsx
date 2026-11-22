import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const title = 'درخواست پاسخ فارسی با React';

const renderRow = (compact: boolean, projectLine = false) => root.render(<SessionTimelineRowBody
  compact={compact}
  project={null}
  projectLabel={projectLine ? 'openchamber' : null}
  projectLine={projectLine}
  title={title}
  titleClassName=""
  branchLabel={null}
  statusDot={null}
  pinnedMarker={null}
  timeSlot="1m"
  directoryIndicator={null}
  prBadge={null}
  zombieIndicator={null}
  badges={null}
  hideMetaOnHoverClass=""
/>);

// A truncated title in an LTR box clips an RTL title's beginning, because its
// first word sits at the right edge. dir=auto lets the title own its direction.
for (const [compact, projectLine] of [[true, false], [false, false], [false, true]] as const) {
  test(`the title resolves its own direction (compact: ${compact}, project line: ${projectLine})`, async () => {
    await act(async () => renderRow(compact, projectLine));
    // The innermost box holding the title is the one that truncates it.
    const element = Array.from(document.querySelectorAll('div')).reverse().find((node) => node.textContent === title);
    expect(element?.getAttribute('dir')).toBe('auto');
  });
}

// The list by time names the project above the title, with the time beside
// it, and keeps the branch line, so a row has three lines.
test('a project line puts the project and time above the title', async () => {
  await act(async () => renderRow(false, true));
  const lines = Array.from(document.querySelector('.flex-col')?.children ?? []).map((line) => line.textContent);
  expect(lines).toEqual(['openchamber1m', title, '']);
});

// Hidden elements leave the row: the branch, the time, the project mark and
// the provider logo go away, while the live status stays.
test('hidden row elements hide without moving the row', async () => {
  await act(async () => root.render(<SessionTimelineRowBody
    compact={false}
    project={{ id: 'p', icon: null, color: null, iconImage: null, iconBackground: null }}
    projectLabel="openchamber"
    title={title}
    titleClassName=""
    branchLabel="main"
    statusDot={<span data-testid="status">live</span>}
    pinnedMarker={<span>pin</span>}
    timeSlot="1m"
    directoryIndicator={<span>dir</span>}
    prBadge={<span>badge</span>}
    zombieIndicator={null}
    badges={null}
    doneHint={<span>done</span>}
    providerId="anthropic"
    hideMetaOnHoverClass=""
    elements={{ showBranch: false, showPrBadge: false, showProviderLogo: false, showProjectIcon: false, showGoal: false, showTime: false, showPinnedMarker: false, showDoneHint: false, showDirectoryIndicator: false }}
  />));
  const body = document.querySelector('.flex-col');
  expect(body?.textContent).toContain(title);
  expect(body?.textContent).toContain('live');
  expect(body?.textContent).not.toContain('main');
  expect(body?.textContent).not.toContain('1m');
  expect(body?.textContent).not.toContain('badge');
  expect(body?.textContent).not.toContain('pin');
  expect(body?.textContent).not.toContain('done');
  expect(body?.textContent).not.toContain('dir');
  // The branch line still renders, so the row keeps its neighbour's height.
  expect(body?.children).toHaveLength(2);
});
