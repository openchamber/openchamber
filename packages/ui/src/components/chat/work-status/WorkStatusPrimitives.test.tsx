import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useUIStore } from '@/stores/useUIStore';
import { themes } from '@/lib/theme/themes';
import { contrastRatio, mixColor, withOpacity } from '@/lib/theme/color';

// Imported once a DOM exists: the tooltip's layout effects check for one when
// their module loads, and without it the popup never mounts.
let primitives: typeof import('./WorkStatusPrimitives.tsx');

const withDom = async (run: (container: HTMLElement, render: (node: React.ReactNode) => Promise<void>) => Promise<void>) => {
  const dom = new Window({ url: 'http://status.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLIFrameElement: dom.HTMLIFrameElement,
    Event: dom.Event,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    ResizeObserver: dom.ResizeObserver,
    MutationObserver: dom.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  primitives = await import('./WorkStatusPrimitives.tsx');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const previous = useUIStore.getState().workStatusExpandedSections;
  try {
    await run(container, (node) => act(async () => root.render(node)));
  } finally {
    await act(async () => useUIStore.setState({ workStatusExpandedSections: previous }));
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
};

test('saved expansion overrides a section default and keeps below-title actions independent', async () => {
  await withDom(async (container, render) => {
    const { WorkStatusCollapsibleSection } = primitives;
    await act(async () => useUIStore.setState({ workStatusExpandedSections: { extension: false } }));
    await render(
      <WorkStatusCollapsibleSection
        id="extension"
        title="Extension"
        defaultExpanded
        actionLayout="below"
        action={<button type="button">Guest action</button>}
      >
        <span>Frame body</span>
      </WorkStatusCollapsibleSection>,
    );

    expect(container.textContent).toContain('Guest action');
    expect(container.textContent).not.toContain('Frame body');
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('Section toggle did not render');
    await act(async () => toggle.click());
    expect(container.textContent).toContain('Frame body');
  });
});

/*
 * The interface size setting scales the root font, so only rem sizes follow
 * it. With row text fixed at 13px and headings in rem, 200% showed 24px
 * headings over 13px rows in 56px rows. Sizes from the typography scale keep
 * the panel's proportions at every interface size; so do rem sizes.
 */
const PX_TEXT_SIZE = /\btext-\[\d+(?:\.\d+)?px\]/g;
/** The innermost element showing exactly `text`. */
const byText = (container: Element, selector: string, text: string) => [...container.querySelectorAll(selector)]
  .filter((element) => element.textContent === text)
  .at(-1);

test('no file drawn in the panel sizes text in px', () => {
  const componentsRoot = fileURLToPath(new URL('../..', import.meta.url));
  const files = [
    ...readdirSync(join(componentsRoot, 'chat/work-status'))
      .filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))
      .map((file) => `chat/work-status/${file}`),
    // Drawn inside the panel's Project section.
    'desktop/OpenInAppButton.tsx',
  ];
  // Positive control: the scan reads the panel's files, and the pattern
  // catches the sizes the panel used to set.
  expect(files).toContain('chat/work-status/WorkStatusPrimitives.tsx');
  expect(files).toContain('chat/work-status/WorkStatusPrimaryGroup.tsx');
  expect('text-[13px] text-[11px] text-[9px]'.match(PX_TEXT_SIZE)).toEqual(['text-[13px]', 'text-[11px]', 'text-[9px]']);

  const found = files.flatMap((file) => [...readFileSync(join(componentsRoot, file), 'utf8').matchAll(PX_TEXT_SIZE)]
    .map((match) => `${file}: ${match[0]}`));
  expect(found).toEqual([]);
});

/** Makes the browser report `element` narrower than its text, as `truncate` cuts it. */
const cutOff = (element: Element | null | undefined) => {
  if (!element) throw new Error('Nothing to cut off');
  Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => 240 });
  Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => 80 });
};
const tooltipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
const focus = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing to focus');
  await act(async () => element.focus());
};
const blur = async () => {
  const active = document.activeElement;
  if (active instanceof HTMLElement) await act(async () => active.blur());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};

test('text the panel cuts off shows in full in a tooltip, and text that fits shows none', async () => {
  await withDom(async (container, render) => {
    const { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusSection } = primitives;
    const branch = 'feature/a-branch-name-longer-than-the-panel';
    await render(
      <>
        <WorkStatusSection title="Project" icon="git-branch">
          <WorkStatusRow icon="git-branch" onClick={() => undefined} ariaLabel="Open branch" label={branch} />
          <WorkStatusRow icon="file-edit" onClick={() => undefined} ariaLabel="Open changes" label="2 files" />
          <WorkStatusRow label="Subagent title" tooltip="Model name" />
        </WorkStatusSection>
        <WorkStatusCollapsibleSection id="probe-cut" title="Usage" icon="timer" summary="AI Credits" defaultExpanded>
          <span>Body</span>
        </WorkStatusCollapsibleSection>
      </>,
    );

    // A row label that fits says nothing more.
    await focus(container.querySelector('button[aria-label="Open changes"]'));
    expect(tooltipText()).toBeNull();
    await blur();

    // A cut row label shows in full.
    cutOff(byText(container, 'span[id]', branch));
    await focus(container.querySelector('button[aria-label="Open branch"]'));
    expect(tooltipText()).toBe(branch);
    await blur();

    // A caller's tooltip shows whether or not the label fits.
    await focus(byText(container, '[tabindex="0"]', 'Subagent title'));
    expect(tooltipText()).toBe('Model name');
    await blur();

    // A heading that fits says nothing more; a cut one shows its title and summary.
    const toggle = container.querySelector('button[aria-expanded]');
    await focus(toggle);
    expect(tooltipText()).toBeNull();
    await blur();
    cutOff(byText(container, 'button[aria-expanded] span', 'Usage'));
    await focus(toggle);
    expect(tooltipText()).toBe('UsageAI Credits');
  });
});

const classes = (element: Element | null | undefined) => (element?.getAttribute('class') ?? '').split(/\s+/);
/** Shrinks below its text and shows an ellipsis. */
const canBeCut = (element: Element | null | undefined) => classes(element).includes('min-w-0') && classes(element).includes('truncate');

/*
 * happy-dom does no layout, so these pin the flex rules that decide what is
 * cut first. A flex item without `min-w-0` or with `shrink-0` cannot shrink
 * below its text; `min-w-0` with `truncate` can.
 */
test('a section title keeps its width and its summary is cut first', async () => {
  await withDom(async (container, render) => {
    const { WorkStatusCollapsibleSection, WorkStatusSection } = primitives;
    await render(
      <>
        <WorkStatusSection title="Project" icon="git-branch" subject="a-project-name-longer-than-the-panel" summary="2 apps">
          <span>Body</span>
        </WorkStatusSection>
        <WorkStatusCollapsibleSection id="probe-usage" title="Usage" icon="timer" summary="Five-hour window 42%" defaultExpanded>
          <span>Body</span>
        </WorkStatusCollapsibleSection>
        <WorkStatusCollapsibleSection id="probe-alone" title="An extension with a long title" defaultExpanded>
          <span>Body</span>
        </WorkStatusCollapsibleSection>
      </>,
    );

    const usage = byText(container, 'button[aria-expanded] span', 'Usage');
    const usageSummary = byText(container, '[data-work-status-heading] [dir="auto"]', 'Five-hour window 42%');
    // Positive control: the elements checked rendered.
    expect(usage).toBeDefined();
    expect(usageSummary).toBeDefined();
    expect(classes(usage)).toContain('shrink-0');
    expect(classes(usage)).not.toContain('min-w-0');
    expect(canBeCut(usageSummary)).toBe(true);

    // Without a summary there is nothing to cut first, so the title may be cut.
    const alone = byText(container, 'button[aria-expanded] span', 'An extension with a long title');
    expect(canBeCut(alone)).toBe(true);
    expect(classes(alone)).not.toContain('shrink-0');

    // The heading keeps its title's width, so the trailing text beside it gives way first.
    const heading = container.querySelector('h3');
    const trailing = byText(container, '[data-work-status-heading] [dir="auto"]', '2 apps');
    expect(heading?.textContent).toBe('Project');
    expect(classes(heading)).toContain('shrink-0');
    expect(classes(heading)).not.toContain('min-w-0');
    expect(canBeCut(trailing)).toBe(true);
  });
});

test('an inactive row steps back and every other row keeps full contrast', async () => {
  await withDom(async (container, render) => {
    const { WorkStatusRow } = primitives;
    await render(
      <>
        <WorkStatusRow label="connected-server" />
        <WorkStatusRow label="disconnected-server" inactive />
      </>,
    );
    const plain = byText(container, 'span[id]', 'connected-server');
    const inactive = byText(container, 'span[id]', 'disconnected-server');
    // Positive control: both labels rendered.
    expect(plain).toBeDefined();
    expect(inactive).toBeDefined();
    expect(classes(inactive)).toContain('opacity-75');
    // A plain row's label is the row's own colour, unfaded.
    const colour = (name: string) => name.startsWith('text-') && !name.startsWith('text-[');
    expect(classes(plain).some((name) => name.startsWith('opacity-') || colour(name))).toBe(false);
    // The row's colour is inherited, so hovering a clickable row still brightens it.
    expect(classes(inactive).some(colour)).toBe(false);
  });
});

/*
 * Only a disconnected MCP server steps back (maintainer decision): the step
 * is under 4.5:1 in all but one built-in theme, so a row the reader needs,
 * such as skills, pinned items or the Checks label, stays at full contrast.
 */
test('only the MCP section marks a row inactive, for a server that is not connected', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const uses = readdirSync(dir)
    .filter((file) => file.endsWith('.tsx') && !file.includes('.test.') && file !== 'WorkStatusPrimitives.tsx')
    .flatMap((file) => [...readFileSync(join(dir, file), 'utf8').matchAll(/\binactive\b[^\n]*/g)].map((match) => `${file}: ${match[0].trim()}`));
  expect(uses).toEqual(['WorkStatusMcpSection.tsx: inactive={!connected}']);
});

test('a disconnected MCP server stays at 3:1 or more on the panel, and other rows at 4.5:1, in every built-in theme', () => {
  expect(themes.length).toBeGreaterThan(50);
  const failures = themes.flatMap((theme) => {
    const { surface } = theme.colors;
    // The panel's page: the muted surface, halfway to it in light themes.
    const page = theme.metadata.variant === 'dark' ? surface.muted : mixColor(surface.muted, surface.background, 0.5, surface.background);
    const inactive = contrastRatio(withOpacity(surface.mutedForeground, 0.75), page, surface.background) ?? 0;
    const plain = contrastRatio(surface.mutedForeground, page, surface.background) ?? 0;
    return [
      ...(inactive < 3 ? [`${theme.metadata.id} inactive: ${inactive.toFixed(2)}`] : []),
      ...(plain < 4.5 ? [`${theme.metadata.id} plain: ${plain.toFixed(2)}`] : []),
    ];
  });
  expect(failures).toEqual([]);
});

/*
 * The state colour as text on its own 18% tint fell below 4.5:1 in most
 * built-in themes; the theme computes `--pr-<state>-text` for it, and
 * readableColors.test.ts measures those against every theme. This pins that
 * the pill uses them. Read from the source: the Project section needs the
 * whole git and PR stack to render.
 */
test('the pull request pill paints its text in the readable colour', () => {
  const source = readFileSync(fileURLToPath(new URL('./WorkStatusPrimaryGroup.tsx', import.meta.url)), 'utf8');
  const pills = [...source.matchAll(/<WorkStatusPill\b([^>]*)>/g)].map((match) => match[1]);
  // Positive control: the pill is there to check.
  expect(pills).toHaveLength(1);
  expect(/color=\{`var\(--pr-\$\{prSummary\.visualState\}-text\)`\}/.test(pills[0] ?? '')).toBe(true);
  expect(/background=\{`color-mix\(in srgb, var\(--pr-\$\{prSummary\.visualState\}\) \$\{PR_PILL_TINT \* 100\}%, transparent\)`\}/.test(pills[0] ?? '')).toBe(true);
});
