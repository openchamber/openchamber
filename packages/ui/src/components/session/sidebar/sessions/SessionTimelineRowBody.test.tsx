import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { MobileTwoLineLayout } from '@/apps/mobileSidebar/mobileRowParts';
import { useProjectsStore } from '@/stores/useProjectsStore';

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

// An extension's mark comes and goes while the app runs, so it must not
// change the row's height: it never opens the second line by itself.
test('an extension mark opens no second line and rides in the first line until something else opens it', async () => {
  const marks = <span data-mark>Mark</span>;
  const order = (line: Element | null | undefined) => Array.from(line?.querySelectorAll('[data-slot]') ?? []).map((node) => node.getAttribute('data-slot'));
  const slots = {
    goal: <span data-slot="goal" />,
    prBadge: <span data-slot="pr" />,
    marks: <span data-slot="marks" data-mark />,
    badges: <span data-slot="badges" />,
  };

  await act(async () => renderRow(false, false, { marks }));
  expect(document.querySelector('.h-4')).toBeNull();
  expect(document.querySelector('.h-5 [data-mark]')).not.toBeNull();

  await act(async () => renderRow(false, false, { marks, branchLabel: 'main' }));
  expect(document.querySelector('.h-4 [data-mark]')).not.toBeNull();
  expect(document.querySelector('.h-5 [data-mark]')).toBeNull();
  expect(document.querySelectorAll('[data-mark]')).toHaveLength(1);

  // Right after the PR badge and before the host's own attention marks, on both row forms.
  await act(async () => renderRow(false, false, slots));
  expect(order(document.querySelector('.h-4'))).toEqual(['goal', 'pr', 'marks', 'badges']);
  expect(order(document.querySelector('.h-5'))).toEqual([]);
  await act(async () => renderRow(true, false, slots));
  expect(order(document.body)).toEqual(['goal', 'pr', 'marks', 'badges']);
});

test('a branch name opens its line without an icon, and the chevron sits over it on hover', async () => {
  const toggle = <button data-toggle>Expand</button>;
  for (const withProject of [false, true]) {
    await act(async () => renderRow(false, withProject, { branchLabel: 'main' }));
    expect(document.querySelector('[href="#oc-git-branch"]')).toBeNull();
  }
  // Pointer layouts: the chevron overlays the name's start, which fades under it.
  await act(async () => renderRow(false, false, { branchLabel: 'main', leadToggle: toggle, leadMaskClassName: 'mask-on-hover' }));
  const name = Array.from(document.querySelectorAll('span')).find((node) => node.textContent === 'main');
  expect(name?.className).toContain('mask-on-hover');
  expect(document.querySelector('[data-toggle]')?.parentElement?.className).toContain('absolute');
  // Touch layouts show the chevron always, so it takes its own place before the name.
  await act(async () => renderRow(false, false, { branchLabel: 'main', leadToggle: toggle }));
  expect(Array.from(document.querySelectorAll('span')).find((node) => node.textContent === 'main')?.className).not.toContain('mask-on-hover');
  expect(document.querySelector('[data-toggle]')?.parentElement?.className).not.toContain('absolute');
  // A space keeps its mark, and the chevron stands on it.
  await act(async () => renderRow(false, false, { branchLabel: 'Fix login', spaceMark: 'Space', leadToggle: toggle, leadMaskClassName: 'mask-on-hover' }));
  expect(document.querySelector('[href="#oc-instance"]')).not.toBeNull();
  expect(Array.from(document.querySelectorAll('span')).find((node) => node.textContent === 'Fix login')?.className).not.toContain('mask-on-hover');
});

test('a zone row prints its project name once there are several projects, and the name gives way before the branch', async () => {
  const records = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `project-${index}`, path: `/work/p${index}` }));
  const setProjects = (count: number) => act(async () => useProjectsStore.setState({ projects: records(count) }));
  const secondLine = () => document.querySelector('div.h-4');
  const named = { ...project, label: 'openchamber-website' };
  try {
    // One project: its icon alone, which speaks the name.
    await setProjects(1);
    await act(async () => renderRow(false, true, { project: named, branchLabel: 'main' }));
    expect(secondLine()?.textContent).toBe('main');
    expect(secondLine()?.querySelector('[aria-label="openchamber"]')).not.toBeNull();

    // Several: the name, a dot, the branch; the icon no longer repeats the name.
    await setProjects(2);
    await act(async () => renderRow(false, true, { project: named, branchLabel: 'main' }));
    expect(secondLine()?.textContent).toBe('openchamber-website·main');
    expect(secondLine()?.querySelector('[aria-label="openchamber"]')).toBeNull();
    const name = Array.from(secondLine()?.querySelectorAll('span') ?? []).find((node) => node.textContent === 'openchamber-website');
    expect(name?.className).toContain('shrink-[999]');
    expect(name?.className).toContain('min-w-16');

    // A short name stays whole, and falls back to the folder's name.
    await act(async () => renderRow(false, true, { project: { ...project, path: '/work/akm' }, branchLabel: 'main' }));
    expect(secondLine()?.textContent).toBe('akm·main');
    expect(Array.from(secondLine()?.querySelectorAll('span') ?? []).find((node) => node.textContent === 'akm')?.className).toContain('shrink-0');

    // No dot with nothing after the name, or before what brings its own icon.
    await act(async () => renderRow(false, true, { project: named }));
    expect(secondLine()?.textContent).toBe('openchamber-website');
    await act(async () => renderRow(false, true, { project: named, branchLabel: 'Fix login', spaceMark: 'Space' }));
    expect(secondLine()?.textContent).toBe('openchamber-websiteFix login');

    // Under its project header a row names no project.
    await act(async () => renderRow(false, false, { branchLabel: 'main' }));
    expect(secondLine()?.textContent).toBe('main');
  } finally {
    await setProjects(0);
  }
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
