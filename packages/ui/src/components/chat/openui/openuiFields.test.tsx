import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RiArrowRightLine, RiArrowRightCircleLine, RiExchangeLine, RiExchangeFill, RiCheckboxCircleLine, RiAB, Ri24HoursLine, Ri4kLine } from '@remixicon/react';
import type { ActionEvent, RendererProps } from '@openuidev/react-lang';
import type { OpenUIMount } from './openuiHost';

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLFormElement: browser.HTMLFormElement, Event: browser.Event, CustomEvent: browser.CustomEvent, PointerEvent: browser.PointerEvent,
  Element: browser.Element, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  Node: browser.Node, MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
const realFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  if (url.includes('/api/location')) return Response.json({ directory: '/repo', project: { directory: '/repo' } });
  return Response.json({ data: [], cursor: {} });
};
const { createRoot } = await import('react-dom/client');
const { Renderer, defineComponent } = await import('@openuidev/react-lang');
const { chamberLibrary } = await import('./openuiCatalog');
const { OpenUIHostContext } = await import('./openuiHost');
const { useOpenUIHost } = await import('./openuiHost');
const { htmlViewProps } = await import('./openuiCatalog.schema');
const { deriveOpenUICatalog } = await import('./openuiCatalog.schema');
const { inspectOpenUIProgram, walkRenderedOpenUINodes } = await import('../../../../../web/shared/openui/program.js');
const { nativeOpenUIImageSources } = await import('../../../../../web/shared/openui/media.js');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { I18nProvider } = await import('@/lib/i18n');
const { useI18nStore } = await import('@/lib/i18n/store');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useThemeSystem } = await import('@/contexts/useThemeSystem');
const { OpenUITheme } = await import('./openuiTheme');
const { useTheme } = await import('@openuidev/react-ui/ThemeProvider');
const { MarkdownMediaProvider } = await import('../markdown/MarkdownMediaContext');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
let enabled = true;
const events: ActionEvent[] = [];
let snapshot: NonNullable<RendererProps['initialState']> = {};
let rendererErrors: Parameters<NonNullable<RendererProps['onError']>>[0] = [];
const mount: OpenUIMount = {
  occurrence: 'root',
  host: {
    owner: { runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 's', messageId: 'm', partId: 'p' },
    renderKey: 'initial', canInteract: () => enabled, submit: async () => {},
    access: { kind: 'interactive' }, answer: null,
    initialMediaSources: [],
    submission: { kind: 'ready' as const, answer: null },
  },
};
async function draw(source: string, key = source, initialState?: RendererProps['initialState']) {
  rendererErrors = [];
  const catalog = deriveOpenUICatalog();
  const inspected = inspectOpenUIProgram(source, catalog.schema, catalog.componentSlots);
  mount.host.initialMediaSources = inspected.valid
    ? walkRenderedOpenUINodes(inspected.root, catalog.componentSlots).flatMap(nativeOpenUIImageSources)
    : [];
  await act(async () => root.render(
    <I18nProvider><OpenUIHostContext.Provider value={mount}>
      <MarkdownMediaProvider content={key} mode="assistant" directory="/repo" sessionId="s" messageId="m" settled>
      <Renderer key={key} response={source} library={chamberLibrary} isStreaming={false} publishObservability={false}
        initialState={initialState} onStateUpdate={(state) => { snapshot = structuredClone(state); }} onAction={(event) => events.push(event)}
        onError={(errors) => { rendererErrors = errors; }} />
      </MarkdownMediaProvider>
    </OpenUIHostContext.Provider></I18nProvider>,
  ));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!button) throw new Error(`Missing ${text}`);
  await act(async () => button.click());
}
async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input.tagName === 'TEXTAREA'
    ? browser.HTMLTextAreaElement.prototype
    : browser.HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!set) throw new Error('Missing input setter');
  await act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
afterAll(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = realFetch;
  await browser.happyDOM.abort();
});

test('real fields hydrate all defaults into the official form payload before edits', async () => {
  expect(chamberLibrary.toJSONSchema()).toEqual(deriveOpenUICatalog().schema);
  events.length = 0;
  await draw(`root = Stack([form])
form = Form("prefs", Buttons([Button("Send", @ToAssistant("Use defaults"))]), [
  FormControl("Name", Input("name", null, null, {required: true}, "Alice")),
  FormControl("Choice", Select("choice", [SelectItem("a", "A")], null, null, "a")),
  FormControl("Flags", CheckBoxGroup("flags", [CheckBoxItem("Flag", "Detail", "flag", true)])),
  FormControl("Radio", RadioGroup("radio", [RadioItem("A", "Detail", "a")], "a")),
  FormControl("Chips", Chips("chips", "multiple", [ChipItem("a", "A")], null, ["a"])),
  FormControl("Cards", OptionCards("cards", "single", [OptionCard("a", "A", "Detail")], null, "a")),
  FormControl("Slider", Slider("slider", "continuous", 0, 10, 1, [4]))
])`);
  await click('Send');
  expect(events).toHaveLength(1);
  expect(events[0].formName).toBe('prefs');
  expect(events[0].formState).toMatchObject({
    prefs: {
      name: { value: 'Alice' }, choice: { value: 'a' }, flags: { value: { flag: true } },
      radio: { value: 'a' }, chips: { value: ['a'] }, cards: { value: 'a' }, slider: { value: [4] },
    },
  });
});

test('grid tracks fit the container and reset spans after narrowing without losing fields', async () => {
  let width = 800;
  let resize: (() => void) | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(browser.HTMLElement.prototype, 'clientWidth');
  const OriginalObserver = globalThis.ResizeObserver;
  Object.defineProperty(browser.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  globalThis.ResizeObserver = class extends OriginalObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      resize = () => callback([], this);
    }
  };
  try {
    document.documentElement.style.fontSize = '16px';
    await draw(`root = Stack([Grid([GridItem([Input("name", null, null, null, "Alice")], 2, 2), TextContent("Detail")], {columns: [2, 1], minChildWidth: 12})])`);
    const grid = host.querySelector<HTMLElement>('.openui-grid');
    const item = host.querySelector<HTMLElement>('.openui-grid-item');
    const input = host.querySelector('input');
    expect(grid?.style.gridTemplateColumns).toBe('minmax(0, 2fr) minmax(0, 1fr)');
    expect(item?.style.gridColumn).toBe('span 2');
    if (!input) throw new Error('Missing grid input');
    await edit(input, 'Preserved');
    width = 360;
    await act(async () => resize?.());
    expect(item?.style.gridColumn).toBe('span 1');
    expect(item?.style.gridRow).toBe('span 1');
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe('Preserved');
  } finally {
    globalThis.ResizeObserver = OriginalObserver;
    if (descriptor) Object.defineProperty(browser.HTMLElement.prototype, 'clientWidth', descriptor);
    else Reflect.deleteProperty(browser.HTMLElement.prototype, 'clientWidth');
  }
});

test('gallery records and image captions keep denied paths inert', async () => {
  await draw(`root = Stack([ImageGallery([{src: "/tmp/gallery.png", alt: "Gallery", details: "Detail"}]),
    Image("Picture", "/tmp/picture.png", {aspectRatio: 2, fit: "cover", caption: "Caption"})])`);
  expect(host.querySelector('figcaption')?.textContent).toBe('Detail');
  expect(host.textContent).toContain('Caption');
  expect(host.querySelector<HTMLElement>('[data-openui-image]')?.style.aspectRatio).toBe('1.5 / 1');
  expect(host.querySelector('img[src="/tmp/gallery.png"]')).toBeNull();
});

test('reactively replaced unsafe action plans stay disabled and cannot submit', async () => {
  events.length = 0;
  await draw(`$action = null
root = Stack([Button("Dynamic", $action), Button("Replace", @Set($action, {steps: [{type: "continue_conversation", message: "Bad"}, {type: "reset", targets: ["$action"]}]}))])`);
  await click('Replace');
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Dynamic');
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(events).toHaveLength(0);
});

test('a grouped action callback rechecks the current host before local mutation', async () => {
  await draw(`$name = "Alice"
root = Stack([Input("name", null, null, null, $name), Buttons([Button("Set", @Set($name, "Changed"))])])`);
  const input = host.querySelector('input');
  enabled = false;
  await click('Set');
  expect(input?.value).toBe('Alice');
  enabled = true;
});

test('real edit, Set, Reset and required validation preserve store and labels across forms', async () => {
  events.length = 0;
  await draw(`$name = "Alice"
root = Stack([form, other])
form = Form("prefs", Buttons([Button("Send", @ToAssistant("Use name")), Button("Set", @Set($name, "Set name")), Button("Reset", @Reset($name))]), [FormControl("Name", Input("name", null, null, {required: true}, $name))])
other = Form("other", Buttons([Button("Other", @ToAssistant("Other"))]), [FormControl("Other name", Input("name", null, null, null, "Other"))])`);
  const inputs = [...host.querySelectorAll('input')].filter((input) => input.type !== 'hidden');
  expect(inputs).toHaveLength(2);
  expect(inputs[0].id).not.toBe(inputs[1].id);
  for (const input of inputs) expect(host.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
  await edit(inputs[0], 'Bob');
  await click('Send');
  expect(events.at(-1)?.formState).toMatchObject({ $name: 'Bob' });
  await click('Set');
  expect(inputs[0].value).toBe('Set name');
  await click('Reset');
  expect(inputs[0].value).toBe('Alice');
  await edit(inputs[0], '');
  const count = events.length;
  await click('Send');
  expect(events).toHaveLength(count);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(inputs[1].value).toBe('Other');
});

test('terminal controls are disabled and a stale event cannot mutate reactive state', async () => {
  enabled = false;
  await draw('root = Stack([Input("name", null, null, null, "Alice"), Button("Send", @ToAssistant("Send"))])');
  const input = host.querySelector('input');
  expect(input?.disabled).toBe(true);
  expect(host.querySelector('button')?.disabled).toBe(true);
  enabled = true;
});

for (const component of ['Input', 'TextArea']) {
  test(`${component} clears errors on focus/edit, validates on blur and gates stale writes`, async () => {
    events.length = 0;
    await draw(`root = Stack([Form("text", Buttons([Button("Use text", @ToAssistant("Use text"))]), [FormControl("Text", ${component}("value", null, null, {required: true}))])])`);
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
    if (!input) throw new Error('Missing text field');
    await click('Use text');
    expect(events).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => input.focus());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await edit(input, 'Edited');
    await edit(input, '');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => input.blur());
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await edit(input, 'Kept');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    enabled = false;
    try {
      await edit(input, 'Rejected');
    } finally {
      enabled = true;
    }
    await click('Use text');
    expect(events.at(-1)?.formState).toMatchObject({
      text: { value: { value: 'Kept', componentType: component } },
    });
  });
}

test('a read-only DatePicker disables its native date field', async () => {
  enabled = false;
  await draw('root = Stack([DatePicker("date")])');
  expect(host.querySelector('fieldset')?.disabled).toBe(true);
  const input = host.querySelector<HTMLInputElement>('input[type="date"]');
  expect(input?.disabled).toBe(true);
  expect(input?.getAttribute('aria-label')).toBe('Date');
  enabled = true;
});

test('checkbox, switch and choice defaults survive editing a different field', async () => {
  events.length = 0;
  await draw(`root = Stack([SwitchGroup("switches", [SwitchItem("Enabled", "Details", "enabled", true)]), form])
form = Form("choices", Buttons([Button("Send", @ToAssistant("Choose"))]), [
  FormControl("Check", CheckBoxGroup("checks", [CheckBoxItem("Checked", "Details", "checked", true), CheckBoxItem("Other", "Details", "other", false)], {required: true})),
  FormControl("Chips", Chips("chips", "multiple", [ChipItem("a", "A"), ChipItem("b", "B")], null, ["a"]))
])`);
  await click('B');
  await click('Send');
  expect(events.at(-1)?.formState).toMatchObject({
    choices: { checks: { value: { checked: true, other: false } }, chips: { value: ['a', 'b'] } },
  });
  expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
  const check = host.querySelector<HTMLElement>('[role="checkbox"]');
  if (!check) throw new Error('Missing checkbox');
  await act(async () => check.click());
  const count = events.length;
  await click('Send');
  expect(events).toHaveLength(count);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('At least one option is required');
});

test('Table keeps 10-row pagination and renders component cells', async () => {
  await draw(`root = Stack([Table([Col("Value", [TextContent("First"), "2", "3", "4", "5", "6", "7", "8", "9", "10", "Last"])])])`);
  expect(host.querySelectorAll('tbody tr')).toHaveLength(10);
  expect(host.querySelector('tbody td')?.textContent).toBe('First');
  const next = [...host.querySelectorAll('button')].at(-1);
  if (!next) throw new Error('Missing next page');
  await act(async () => next.click());
  expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(host.querySelector('tbody td')?.textContent).toBe('Last');
});

test('single choices stay cleared after editing another field and restoring a snapshot', async () => {
  for (const component of ['Chips("choice", "single", [ChipItem("a", "Choice A")], null, "a")',
    'OptionCards("choice", "single", [OptionCard("a", "Choice A")], null, "a")']) {
    const source = `root = Stack([${component}, Input("other")])`;
    await draw(source);
    await click('Choice A');
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    const input = host.querySelector('input');
    if (!input) throw new Error('Missing unrelated field');
    await edit(input, 'Edited');
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
    await draw(source, `restored-${component}`, snapshot);
    expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
  }
});

test('Select shows the option label while keeping its stored value', async () => {
  events.length = 0;
  await draw('root = Stack([Select("order", [SelectItem("asc", "Low to high")], null, null, "asc"), Button("Use order", @ToAssistant("Use order"))])');
  expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe('Low to high');
  await click('Use order');
  expect(events.at(-1)?.formState).toMatchObject({ order: { value: 'asc' } });
});

test('Slider updates the shared value before an immediate submission', async () => {
  events.length = 0;
  await draw(`root = Stack([Form("prefs", Buttons([Button("Send slider", @ToAssistant("Use number"))]), [FormControl("Number", Slider("number", "continuous", 0, 10, 0.5, [4], null, null, $number))]), TextContent("Preview " + $number[0])])
$number = [4]`);
  const input = host.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error('Missing slider number input');
  await edit(input, '7.5');
  await click('Send slider');
  expect(host.textContent).toContain('Preview 7.5');
  expect(events.at(-1)?.formState).toMatchObject({ $number: [7.5] });
});

test('DatePicker can be cleared and reset without retaining a second date state', async () => {
  await draw(`root = Stack([DatePicker("date", "single", null, $date), Button("Reset date", @Reset($date))])
$date = null`);
  const input = host.querySelector<HTMLInputElement>('input[type="date"]');
  if (!input) throw new Error('Missing accessible date field');
  await edit(input, '2026-10-22');
  expect(input.value).toBe('2026-10-22');
  await click('Reset date');
  expect(input.value).toBe('');
});

test('date ranges retain Dates through edits and restoration, and an empty date submits null', async () => {
  events.length = 0;
  const source = 'root = Stack([Form("dates", Buttons([Button("Use dates", @ToAssistant("Use dates"))]), [FormControl("Travel dates", DatePicker("travel", "range")), FormControl("Optional date", DatePicker("optional"))])])';
  await draw(source);
  const dates = [...host.querySelectorAll<HTMLInputElement>('input[type="date"]')];
  await edit(dates[0], '2026-10-22');
  await edit(dates[1], '2026-10-25');
  await edit(dates[2], '2026-10-26');
  await edit(dates[2], '');
  await click('Use dates');
  expect(events.at(-1)?.formState).toMatchObject({
    dates: {
      travel: { value: { from: new Date('2026-10-22T00:00:00'), to: new Date('2026-10-25T00:00:00') } },
      optional: { value: null },
    },
  });
  await draw(source, 'restored-dates', snapshot);
  expect([...host.querySelectorAll<HTMLInputElement>('input[type="date"]')].map((input) => input.value))
    .toEqual(['2026-10-22', '2026-10-25', '']);
});

test('numeric Slider edits snap, clamp and order a range in the official store', async () => {
  events.length = 0;
  await draw(`root = Stack([Slider("range", "continuous", 0, 10, 0.5, [2, 8]), Button("Use range", @ToAssistant("Use range"))])`);
  const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')];
  await edit(inputs[0], '4.3');
  await edit(inputs[1], '11');
  await click('Use range');
  expect(events.at(-1)?.formState).toMatchObject({ range: { value: [4.5, 10] } });
  await edit(inputs[1], '-2');
  await click('Use range');
  expect(events.at(-1)?.formState).toMatchObject({ range: { value: [0, 4.5] } });
});

test('a large discrete Slider keeps numeric access without building a huge option list', async () => {
  events.length = 0;
  await draw('root = Stack([Slider("large", "discrete", 0, 1000000, 1000), Button("Use large", @ToAssistant("Use large"))])');
  const input = host.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error('Missing numeric access for a large discrete range');
  await edit(input, '12000');
  await click('Use large');
  expect(events.at(-1)?.formState).toMatchObject({ large: { value: [12000] } });
});

test('Tabs, Accordion and Radio use the real primitives to update local state', async () => {
  events.length = 0;
  await draw(`root = Stack([Tabs([TabItem("a", "Tab A", [TextContent("Content A")]), TabItem("b", "Tab B", [TextContent("Content B")])]), Accordion([AccordionItem("a", "Section A", [TextContent("Section content A")]), AccordionItem("b", "Section B", [TextContent("Section content B")])]), RadioGroup("radio", [RadioItem("Radio A", "", "a"), RadioItem("Radio B", "", "b")], "a"), Button("Use radio", @ToAssistant("Use radio"))])`);
  await click('Tab A');
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Tab A');
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toBe('Content A');
  await click('Section A');
  expect([...host.querySelectorAll('[aria-expanded="true"]')].map((node) => node.textContent)).toContain('Section A');
  const radio = [...host.querySelectorAll('label')].find((node) => node.textContent === 'Radio B');
  if (!radio) throw new Error('Missing Radio B');
  await act(async () => radio.click());
  await click('Use radio');
  expect(events.at(-1)?.formState).toMatchObject({ radio: { value: 'b' } });
});

test('Accordion follows new items until user interaction, then preserves selection and field values', async () => {
  const source = (count: number) => `root = Stack([Accordion([${Array.from({ length: count }, (_, index) => (
    `AccordionItem("${index}", "Section ${index}", [Input("field${index}", null, null, null, "Default ${index}")])`
  )).join(',')}])])`;
  await draw(source(1), 'accordion-growth');
  expect(host.querySelector('[aria-expanded="true"]')?.textContent).toBe('Section 0');
  await draw(source(2), 'accordion-growth');
  expect(host.querySelector('[aria-expanded="true"]')?.textContent).toBe('Section 1');
  await click('Section 0');
  const input = host.querySelector<HTMLInputElement>('input[name="field0"]');
  if (!input) throw new Error('Missing expanded field');
  await edit(input, 'Preserved');
  await draw(source(3), 'accordion-growth');
  expect(host.querySelector('[aria-expanded="true"]')?.textContent).toBe('Section 0');
  expect(host.querySelector('input[name="field0"]')).toBe(input);
  await click('Section 0');
  expect(host.querySelector('[aria-expanded="true"]')).toBeNull();
  expect(host.querySelector('input[name="field0"]')).toBeNull();
  await click('Section 0');
  expect(host.querySelector<HTMLInputElement>('input[name="field0"]')?.value).toBe('Preserved');
  expect(rendererErrors).toEqual([]);
});

test('Accordion keyboard navigation moves focus without changing the expanded section', async () => {
  await draw('root = Stack([Accordion([AccordionItem("a", "Section A", [TextContent("A")]), AccordionItem("b", "Section B", [TextContent("B")])])])');
  const triggers = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
  await act(async () => triggers[0].focus());
  await act(async () => {
    triggers[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.activeElement).toBe(triggers[1]);
  expect(host.querySelector('[aria-expanded="true"]')).toBe(triggers[1]);
  await act(async () => {
    triggers[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.activeElement).toBe(triggers[0]);
  expect(host.querySelector('[aria-expanded="true"]')).toBe(triggers[1]);
});

test('RTL containers preserve text direction, tab navigation and vertical accordion focus', async () => {
  const locale = useI18nStore.getState().locale;
  try {
    await act(async () => useI18nStore.getState().setLocale('ar'));
    await draw('root = Stack([Tabs([TabItem("a", "Tab A", [TextContent("A")]), TabItem("b", "Tab B", [TextContent("B")])]), Accordion([AccordionItem("a", "Section A", [TextContent("A")]), AccordionItem("b", "Section B", [TextContent("B")])])])');
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    await act(async () => tabs[0].focus());
    await act(async () => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(tabs[1]);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')).toBe(tabs[1]);
    const triggers = [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
    // happy-dom does not compute inherited direction from the html dir attribute.
    expect(triggers[0].closest('[dir]')?.getAttribute('dir')).toBe('rtl');
    await act(async () => triggers[0].focus());
    await act(async () => {
      triggers[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(triggers[1]);
  } finally {
    await act(async () => useI18nStore.getState().setLocale(locale));
  }
});

test('component Markdown keeps screen links but cannot load media or execute nested UI', async () => {
  const text = '[Website](https://example.com) [Local](file:///private.txt) ![Private](private.png)\n\n```openui-lang\nroot = Stack([Input("nested")])\n```';
  const before = requests.length;
  await draw(`root = Stack([TextContent(${JSON.stringify(text)}, "small-heavy")])`);
  expect(host.querySelector('a')?.getAttribute('target')).toBe('_blank');
  expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  expect(host.querySelectorAll('a')).toHaveLength(1);
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('pre')?.textContent).toContain('root = Stack');
  expect(requests.slice(before).filter((url) => url.includes('/api/fs'))).toEqual([]);
});

const officialGlyph = (component: typeof RiArrowRightLine) => {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(React.createElement(component));
  return container.querySelector('svg')?.innerHTML;
};

test('Icon renders the official Remix glyphs in Cards and Tags without local sprite substitution', async () => {
  await draw(`root = Stack([Card([Icon("arrow-right-line", {size: "lg", tone: "muted"}), Icon("exchange-line"), Icon("arrow-right-circle-line"), Icon("exchange-fill")]),
    Tag("Saved", Icon("checkbox-circle-line")), Icon("a-b"), Icon("24-hours-line"), Icon("4k-line")])`);
  expect([...host.querySelectorAll('svg')].map((node) => node.innerHTML)).toEqual([
    RiArrowRightLine, RiExchangeLine, RiArrowRightCircleLine, RiExchangeFill, RiCheckboxCircleLine, RiAB, Ri24HoursLine, Ri4kLine,
  ].map(officialGlyph));
  expect(host.querySelector('svg use')).toBeNull();
  expect(host.querySelector('svg')?.getAttribute('class')).toContain('size-5 text-muted-foreground');
  expect(rendererErrors).toEqual([]);
});

test('reactive Icon names render the selected official Remix component', async () => {
  await draw(`$icon = "exchange-line"
root = Stack([Input("icon", null, null, null, $icon), Icon($icon)])`);
  const input = host.querySelector('input');
  if (!input) throw new Error('Missing icon name field');
  await edit(input, 'arrow-right-line');
  expect(host.querySelector('svg')?.innerHTML).toBe(officialGlyph(RiArrowRightLine));
  await edit(input, 'exchange-fill');
  expect(host.querySelector('svg')?.innerHTML).toBe(officialGlyph(RiExchangeFill));
  expect(host.querySelector('svg use')).toBeNull();
  expect(rendererErrors).toEqual([]);
});

for (const options of ['{}', '{width: 12}', '{maxWidth: 30}']) {
  test(`Card sizing options ${options} preserve flex allocation in a wrapping row`, async () => {
    await draw(`root = Stack([card, Icon("arrow-right-line"), card, Icon("arrow-right-line"), card], "row", "s", "center", "start", true)
card = Card([TextContent("Available time", "small-heavy"), TextContent("Estimates and interruptions", "small")], "sunk", "column", "s", "start", "start", false, ${options})`);
    const cards = [...host.querySelectorAll<HTMLElement>('.openui-card')];
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.style.flexGrow).toBe('1');
      expect(card.style.flexShrink).toBe('1');
      expect(card.style.flexBasis).toBe('0%');
      expect(Number.parseFloat(card.style.minInlineSize)).toBe(0);
    }
    expect(rendererErrors).toEqual([]);
  });
}

test('Card sizing overrides can be removed and restored without remounting fields', async () => {
  await draw(`$options = {}
root = Stack([Card([Input("name", null, null, null, "Alice"), Button("Resize", @Set($options, {width: 12, minWidth: 8, maxWidth: 30, grow: 0, shrink: 0})), Button("Clear overrides", @Set($options, {width: 12})), Button("Reset layout", @Reset($options))], null, null, null, null, null, null, $options)])`);
  const card = host.querySelector<HTMLElement>('.openui-card');
  expect(card?.style.alignItems).toBe('stretch');
  expect(card?.style.justifyContent).toBe('flex-start');
  expect(card?.style.flexWrap).toBe('nowrap');
  const input = host.querySelector('input');
  if (!input || !card) throw new Error('Missing layout card or input');
  await edit(input, 'Preserved');
  for (const action of ['Resize', 'Clear overrides', 'Resize', 'Reset layout']) {
    await click(action);
    expect(card.style.inlineSize).toBe(action === 'Reset layout' ? '' : '12rem');
    expect(card.style.maxInlineSize).toBe(action === 'Resize' ? '30rem' : '');
    if (action === 'Resize') expect(card.style.minInlineSize).toBe('8rem');
    else expect(Number.parseFloat(card.style.minInlineSize)).toBe(0);
    expect(card.style.flexGrow).toBe(action === 'Resize' ? '0' : '1');
    expect(card.style.flexShrink).toBe(action === 'Resize' ? '0' : '1');
    expect(card.style.flexBasis).toBe('0%');
    expect(host.querySelector('.openui-card')).toBe(card);
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe('Preserved');
  }
  expect(rendererErrors).toEqual([]);
});

for (const component of ['Stack', 'Card']) {
  test(`${component} keeps focused fields when options change between absent and present`, async () => {
    const skipped = component === 'Card' ? 'null, null, null, null, null, null' : 'null, null, null, null, null';
    await draw(`root = Stack([layout, Button("Pad", @Set($options, {padding: "m"})), Button("Unpad", @Set($options, null))])
$options = null
layout = ${component}([Input("stable", null, null, null, "Alice")], ${skipped}, $options)`);
    const input = host.querySelector('input');
    if (!input) throw new Error('Missing layout field');
    await edit(input, 'Preserved');
    input.focus();
    for (const action of ['Pad', 'Unpad']) {
      await click(action);
      expect(host.querySelector('input') === input).toBe(true);
      expect(document.activeElement === input).toBe(true);
      expect(input.value).toBe('Preserved');
    }
  });
}

test('caption and source metadata preserve natural image sizing', async () => {
  const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const Observer = browser.IntersectionObserver;
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
  try {
    await draw(`root = Stack([Image("Plain", "${data}"), Image("Captioned", "${data}", {caption: "Description", source: "https://example.com"})])`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const plain = host.querySelector<HTMLImageElement>('img[alt="Plain"]');
    const captioned = host.querySelector<HTMLImageElement>('img[alt="Captioned"]');
    if (!plain || !captioned) throw new Error('Missing loaded images');
    expect(captioned.style.cssText).toBe(plain.style.cssText);
    expect(captioned.className).toBe(plain.className);
    expect(host.querySelector('figcaption')?.textContent).toContain('Description');
  } finally {
    Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: Observer });
  }
});

test('an image uses assistant media policy and edited sources stay labels', async () => {
  const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  // Exercise the real viewport path without replacing the media component or owner.
  const Observer = browser.IntersectionObserver;
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
  await draw(`$source = "${data}"
root = Stack([Input("source", null, null, null, $source), Image("Approved", $source)])`);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.querySelector('img')?.getAttribute('src')).toBe(data);
  const input = host.querySelector('input');
  if (!input) throw new Error('Missing image source input');
  await edit(input, '/repo/private.png');
  expect(host.querySelector('img')).toBeNull();
  expect(host.querySelector('[data-oc-media-source="/repo/private.png"]')?.textContent).toBe('Approved');
  expect(requests.filter((url) => /\/api\/fs\/(?:stat|raw)(?:\?|$)/.test(url))).toEqual([]);
  Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: Observer });
});

test('theme font and palette updates preserve the Renderer store and update a real dynamic chart', async () => {
  const appearance = { font: '', palette: Array<string>() };
  function Probe() {
    const { theme } = useTheme();
    const { setThemeMode } = useThemeSystem();
    appearance.font = theme.textLabelXs ?? '';
    appearance.palette = theme.defaultChartPalette ?? [];
    return <button onClick={() => setThemeMode('dark')}>Dark</button>;
  }
  // Canvas is a host seam in happy-dom. This tests runtime/context updates, not browser font metrics.
  Object.defineProperty(browser.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true, value: () => ({ font: '', measureText: (text: string) => ({ width: text.length * 7 }) }),
  });
  document.documentElement.style.setProperty('--font-sans', 'Catalog Sans');
  document.documentElement.style.setProperty('--chart-1', 'rgb(10, 20, 30)');
  document.documentElement.style.setProperty('--chart-2', 'rgb(11, 21, 31)');
  document.documentElement.style.fontSize = '16px';
  await act(async () => root.render(
    <I18nProvider><ThemeSystemProvider><OpenUIHostContext.Provider value={mount}>
      <div id="theme-test"><OpenUITheme cssSelector="#theme-test">
        <Probe />
        <Renderer key="theme" response={`$values = [1, 3]
root = Stack([Input("name", null, null, null, "Alice"), PieChart(["A", "B"], $values), BarChart(["Total"], [Series("Count", [@Sum($values)])]), Button("Update", @Set($values, [3, 1]))])`}
          library={chamberLibrary} isStreaming={false} publishObservability={false} />
      </OpenUITheme></div>
    </OpenUIHostContext.Provider></ThemeSystemProvider></I18nProvider>,
  ));
  const input = host.querySelector('input');
  if (!input) throw new Error('Missing themed field');
  await edit(input, 'Kept');
  const before = host.querySelector('svg[aria-label="Pie chart"]');
  expect(before).not.toBeNull();
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
  expect(host.querySelector('svg[aria-label="Bar chart"]')).not.toBeNull();
  expect(host.textContent).toContain('B75.0%A25.0%');
  await click('Update');
  expect(host.querySelector('svg[aria-label="Pie chart"]')).toBe(before);
  expect(host.textContent).toContain('A75.0%B25.0%');
  await act(async () => {
    document.documentElement.style.setProperty('--font-sans', 'Changed Sans');
    document.documentElement.style.setProperty('--chart-1', 'rgb(40, 50, 60)');
    document.documentElement.style.setProperty('--chart-2', 'rgb(41, 51, 61)');
    document.documentElement.style.fontSize = '20px';
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(appearance.font).toContain('Changed Sans');
  expect(appearance.font).toContain('15px');
  expect(appearance.palette[0]).toBe('rgb(40, 50, 60)');
  const sliceColors = [...host.querySelectorAll('svg[aria-label="Pie chart"] path')].map((path) => path.getAttribute('fill'));
  expect(sliceColors).toContain('rgb(41, 51, 61)');
  expect(host.querySelector('input')).toBe(input);
  expect(input.value).toBe('Kept');
  await click('Dark');
  expect(host.querySelector('input')).toBe(input);
  expect(input.value).toBe('Kept');
});

test('Tabs, Accordion and Table assign separate trusted occurrences to repeated HtmlViews', async () => {
  if (!chamberLibrary.extend) throw new Error('Missing public library extension');
  // Replace only the iframe boundary through the public catalog seam. Containers and runtime stay real.
  const library = chamberLibrary.extend({ components: { override: [defineComponent({
    name: 'HtmlView', props: htmlViewProps, description: 'Attribution probe',
    component: function AttributionProbe() { return <output>{useOpenUIHost().occurrence}</output>; },
  })] } });
  const source = `root = Stack([tabs, accordion])
tabs = Tabs([TabItem("tab", "Tab", [Table([Col("Pages", [page, page])])])])
accordion = Accordion([AccordionItem("section", "Section", [Table([Col("Page", [page])])])])
page = HtmlView("<p>Same HTML</p>")`;
  await act(async () => root.render(
    <I18nProvider><OpenUIHostContext.Provider value={mount}>
      <Renderer key="occurrences" response={source} library={library} isStreaming={false} publishObservability={false} />
    </OpenUIHostContext.Provider></I18nProvider>,
  ));
  const paths = [...host.querySelectorAll('output')].map((output) => output.textContent);
  expect(paths).toEqual([
    'root/children/0/items/0/content/0/columns/0/data/0',
    'root/children/0/items/0/content/0/columns/0/data/1',
    'root/children/1/items/0/content/0/columns/0/data/0',
  ]);
});

test('Accordion preserves occurrence identity when sections reuse the same content array', async () => {
  if (!chamberLibrary.extend) throw new Error('Missing public library extension');
  const library = chamberLibrary.extend({ components: { override: [defineComponent({
    name: 'HtmlView',
    props: htmlViewProps,
    description: 'Attribution probe',
    component: function AttributionProbe() {
      return <output>{useOpenUIHost().occurrence}</output>;
    },
  })] } });
  const source = `root = Stack([Accordion([AccordionItem("a", "First", content), AccordionItem("b", "Second", content)])])
content = [HtmlView("<p>Shared</p>")]`;
  await act(async () => root.render(
    <I18nProvider>
      <OpenUIHostContext.Provider value={mount}>
        <Renderer
          key="shared-accordion-content"
          response={source}
          library={library}
          isStreaming={false}
          publishObservability={false}
        />
      </OpenUIHostContext.Provider>
    </I18nProvider>,
  ));
  expect(host.querySelector('output')?.textContent).toBe('root/children/0/items/1/content/0');
  await click('First');
  expect(host.querySelector('output')?.textContent).toBe('root/children/0/items/0/content/0');
  await click('Second');
  expect(host.querySelector('output')?.textContent).toBe('root/children/0/items/1/content/0');
});

test('multiple theme providers share one appearance observer until the last unmount', async () => {
  await act(async () => root.render(null));
  const observe = spyOn(browser.MutationObserver.prototype, 'observe');
  const disconnect = spyOn(browser.MutationObserver.prototype, 'disconnect');
  const fonts: string[] = [];
  function Probe({ index }: { index: number }) {
    fonts[index] = useTheme().theme.fontBody ?? '';
    return null;
  }
  const drawThemes = (count: number) => act(async () => root.render(
    <ThemeSystemProvider>{Array.from({ length: count }, (_, index) => (
      <OpenUITheme key={index} cssSelector={`#shared-theme-${index}`}><Probe index={index} /></OpenUITheme>
    ))}</ThemeSystemProvider>,
  ));
  try {
    await drawThemes(2);
    expect(observe.mock.calls.filter(([target]) => target === browser.document.documentElement)).toHaveLength(1);
    await act(async () => {
      document.documentElement.style.setProperty('--font-sans', 'Shared Sans');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fonts).toEqual(['Shared Sans', 'Shared Sans']);
    await drawThemes(1);
    expect(disconnect).not.toHaveBeenCalled();
    await drawThemes(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    observe.mockRestore();
    disconnect.mockRestore();
  }
});

test('a Slider field cannot write after its host is retired', async () => {
  await draw(`$number = [4]
root = Stack([Slider("number", "continuous", 0, 10, 1, null, "Number", null, $number), TextContent("Preview " + $number[0])])`);
  const input = host.querySelector<HTMLInputElement>('input[type="number"]');
  if (!input) throw new Error('Missing slider input');
  enabled = false;
  await edit(input, '7');
  expect(host.textContent).toContain('Preview 4');
  enabled = true;
});

test('Callout keeps its original dismissal timer across unrelated field edits', async () => {
  await draw(`$visible = true
root = Stack([Input("name", null, null, null, "Alice"), Callout("info", "Notice", "Details", $visible)])`);
  expect(host.textContent).toContain('Notice');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
  const input = host.querySelector('input');
  if (!input) throw new Error('Missing unrelated field');
  await edit(input, 'Bob');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  expect(host.textContent).not.toContain('Notice');
  expect(input.value).toBe('Bob');
});

for (const media of ['Image("Initial", $source)', 'ImageGallery([{src: $source, alt: "Initial"}])']) {
  test(`the VS Code workspace bridge never reads an edited or restored source through ${media}`, async () => {
    const fetchBefore = globalThis.fetch;
    const paths: string[] = [];
    Object.defineProperty(browser, '__VSCODE_CONFIG__', { configurable: true, value: { workspaceFolder: '/repo' } });
    const Observer = browser.IntersectionObserver;
    Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: undefined });
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/api/fs/')) paths.push(new URL(url, 'http://localhost').pathname);
      if (url.includes('/api/fs/stat')) return Response.json({ isFile: true, size: 12 });
      return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), {
        headers: { 'content-type': 'image/png' },
      });
    };
    try {
      const source = `$source = "initial.png"
root = Stack([Input("source", null, null, null, $source), ${media}])`;
      await draw(source);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(paths).toEqual(['/api/fs/stat', '/api/fs/raw']);
      const input = host.querySelector('input');
      if (!input) throw new Error('Missing workspace image source field');
      await edit(input, 'private.png');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(paths).toEqual(['/api/fs/stat', '/api/fs/raw']);
      expect(host.querySelector('img')).toBeNull();
      await draw(source, 'restored-image', snapshot);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector('input')?.value).toBe('private.png');
      expect(host.querySelector('img')).toBeNull();
      expect(paths).toEqual(['/api/fs/stat', '/api/fs/raw']);
    } finally {
      Object.defineProperty(browser, '__VSCODE_CONFIG__', { configurable: true, value: undefined });
      Object.defineProperty(browser, 'IntersectionObserver', { configurable: true, value: Observer });
      globalThis.fetch = fetchBefore;
    }
  });
}

test('carousel browsing changes the local page without submitting an action', async () => {
  events.length = 0;
  const scroll = spyOn(browser.HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  try {
    await draw('root = Stack([Carousel([[TextContent("First")], [TextContent("Second")], [TextContent("Third")]])])');
    const next = host.querySelector<HTMLButtonElement>('[aria-label="Next page"]');
    const previous = host.querySelector<HTMLButtonElement>('[aria-label="Previous page"]');
    expect(previous?.disabled).toBe(true);
    await act(async () => next?.click());
    expect(host.textContent).toContain('2 / 3');
    expect(previous?.disabled).toBe(false);
    const scroller = host.querySelector('.openui-carousel-content');
    await act(async () => scroller?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(host.textContent).toContain('3 / 3');
    expect(next?.disabled).toBe(true);
    expect(events).toHaveLength(0);
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    scroll.mockRestore();
  }
});

test('carousel mirrors keyboard navigation in RTL and leaves embedded field keys alone', async () => {
  const locale = useI18nStore.getState().locale;
  const scrolled: HTMLElement[] = [];
  const scroll = spyOn(browser.HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    scrolled.push(this);
  });
  try {
    await act(async () => useI18nStore.getState().setLocale('ar'));
    await draw('root = Stack([Carousel([[Input("name", null, null, null, "Alice")], [TextContent("Second")]])])');
    const input = host.querySelector('input');
    const scroller = host.querySelector<HTMLElement>('.openui-carousel-content');
    if (!input || !scroller) throw new Error('Missing carousel field or scroller');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(host.textContent).toContain('1 / 2');
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(host.textContent).toContain('2 / 2');
    expect(scrolled[0] === scroller.children[1]).toBe(true);
    expect(scroll.mock.calls[0]).toEqual([{ block: 'nearest', inline: 'start', behavior: 'instant' }]);
    await act(async () => scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(host.textContent).toContain('1 / 2');
    expect(scrolled[1] === scroller.children[0]).toBe(true);
  } finally {
    scroll.mockRestore();
    await act(async () => useI18nStore.getState().setLocale(locale));
  }
});

test('horizontal bars preserve category names and captions with the legend hidden', async () => {
  await draw(`root = Stack([BarChart(["Desk A", "Desk B"], [Series("label", [3, 5])], "grouped", "cm", "Desk", 240, {orientation: "horizontal", legend: false})])`);
  expect(host.textContent).toContain('Desk A');
  expect(host.textContent).toContain('Desk B');
  expect(host.textContent).toContain('cm · Desk');
  expect(host.querySelector('svg')).not.toBeNull();
});

for (const [component, invalid] of [
  ['BarChart', '{orientation: "diagonal", legend: false}'],
  ['BarChart', '{density: "invalid", legend: false}'],
  ['LineChart', '{density: "invalid", legend: false}'],
  ['AreaChart', '{density: "invalid", legend: false}'],
]) {
  test(`${component} uses one options fallback for chart and caption with ${invalid}`, async () => {
    await draw(`$options = {legend: false}
root = Stack([${component}(["Desk A", "Desk B"], [Series("Count", [3, 5])], null, "cm", "Desk", 240, $options), Button("Invalid options", @Set($options, ${invalid})), Button("Reset options", @Reset($options))])`);
    const captions = () => [...host.querySelectorAll('p')].filter((node) => node.textContent === 'cm · Desk');
    const chart = () => host.querySelector(`svg[aria-label="${component.replace('Chart', ' chart')}"]`);
    const original = chart();
    expect(original).not.toBeNull();
    expect(captions()).toHaveLength(1);
    await click('Invalid options');
    expect(captions()).toHaveLength(0);
    expect(host.textContent).toContain('Count');
    expect(chart() === original).toBe(true);
    expect(rendererErrors).toEqual([]);
    await click('Reset options');
    expect(captions()).toHaveLength(1);
    expect(chart() === original).toBe(true);
  });
}

test('carousel recognizes the last short slide when scrolling reaches the end', async () => {
  await draw('root = Stack([Carousel([[TextContent("First")], [TextContent("Second")], [TextContent("Third")]])])');
  const scroller = host.querySelector<HTMLElement>('.openui-carousel-content');
  if (!scroller) throw new Error('Missing carousel scroller');
  const bounds = (left: number, right: number) => new browser.DOMRect(left, 0, right - left, 100);
  scroller.getBoundingClientRect = () => bounds(0, 1000);
  Object.defineProperties(scroller, { scrollWidth: { value: 1400 }, clientWidth: { value: 1000 } });
  Array.from(scroller.children).forEach((child, index) => {
    child.getBoundingClientRect = () => bounds(-400 + index * 500, index * 500);
  });
  await act(async () => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
  expect(host.textContent).toContain('3 / 3');
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.disabled).toBe(true);
});
