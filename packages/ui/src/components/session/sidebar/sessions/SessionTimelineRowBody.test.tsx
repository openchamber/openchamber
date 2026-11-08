import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { MobileTwoLineLayout } from '@/apps/mobileSidebar/mobileRowParts';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true })) {
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

const project = { id: 'project-a', icon: null, color: null, iconImage: null, iconBackground: null };

const renderRow = (compact: boolean, withProject = false, overrides: Partial<React.ComponentProps<typeof SessionTimelineRowBody>> = {}) => root.render(<SessionTimelineRowBody
  compact={compact}
  project={withProject ? project : null}
  projectLabel={withProject ? 'openchamber' : null}
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
  {...overrides}
/>);

test('an empty detailed line disappears and returns when metadata arrives', async () => {
  await act(async () => renderRow(false));
  expect(document.querySelector('.h-4')).toBeNull();
  for (const overrides of [
    { branchLabel: 'main' },
    { goal: <span>Goal</span> },
    { prBadge: <span>Issue #1</span> },
    { badges: <span>Permission required</span> },
    { badges: <span>Question waiting</span> },
    { leadToggle: <button>Expand</button> },
  ]) {
    await act(async () => renderRow(false, false, overrides));
    expect(document.querySelector('.h-4')).not.toBeNull();
    await act(async () => renderRow(false));
    expect(document.querySelector('.h-4')).toBeNull();
  }
  await act(async () => renderRow(false, true));
  expect(document.querySelector('div.h-4')).not.toBeNull();
});

test('the phone omits an empty line but keeps metadata and its expansion control', async () => {
  for (const [secondLine, chevron, visible] of [
    [null, null, false],
    [<span>Goal and linked task</span>, null, true],
    [null, <button>Expand</button>, true],
  ] as const) {
    await act(async () => root.render(<MobileTwoLineLayout
      indent={12}
      firstLine={title}
      secondLine={secondLine}
      chevron={chevron}
    />));
    expect(document.querySelector('span.h-4') !== null).toBe(visible);
    expect(document.querySelector('.min-h-9')).not.toBeNull();
  }
});

// A truncated title in an LTR box clips an RTL title's beginning, because its
// first word sits at the right edge. dir=auto lets the title own its direction.
for (const [compact, withProject] of [[true, false], [false, false], [false, true]] as const) {
  test(`the title resolves its own direction (compact: ${compact}, project: ${withProject})`, async () => {
    await act(async () => renderRow(compact, withProject));
    // The innermost box holding the title is the one that truncates it.
    const element = Array.from(document.querySelectorAll('div')).reverse().find((node) => node.textContent === title);
    expect(element?.getAttribute('dir')).toBe('auto');
  });
}
