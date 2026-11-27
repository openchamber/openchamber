import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, Node: browser.Node, Element: browser.Element,
  HTMLElement: browser.HTMLElement, HTMLTextAreaElement: browser.HTMLTextAreaElement, Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useOpenWhenReady } = await import('./useOpenWhenReady');
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterAll(async () => {
  await act(async () => root.unmount());
  browser.close();
});

const opened: boolean[] = [];
const setOpen = (open: boolean) => { opened.push(open); };
let request!: (open: boolean) => void;
const Probe = ({ ready, unavailable = false, owner = 'a' }: { ready: boolean; unavailable?: boolean; owner?: string }) => {
  request = useOpenWhenReady(owner, ready, unavailable, setOpen);
  return null;
};
const show = (ready: boolean, unavailable = false) => act(async () => root.render(<Probe ready={ready} unavailable={unavailable} />));
const ask = () => act(async () => request(true));

test('a press before the list is loaded opens the menu once it is', async () => {
  await show(false);
  await ask();
  expect(opened).toEqual([]);
  await show(true);
  expect(opened).toEqual([true]);
});

test('a press is dropped when the window loses focus or the chat changes', async () => {
  opened.length = 0;
  await show(false);
  await ask();
  await act(async () => { window.dispatchEvent(new Event('blur')); });
  await show(true);
  await show(false);
  await ask();
  await act(async () => root.render(<Probe ready={false} owner="b" />));
  await act(async () => root.render(<Probe ready owner="b" />));
  expect(opened).toEqual([]);
});

test('a press is dropped by the next press or key, and by a list that cannot load', async () => {
  for (const type of ['pointerdown', 'keydown']) {
    opened.length = 0;
    await show(false);
    await ask();
    await act(async () => { document.dispatchEvent(new Event(type)); });
    await show(true);
    expect(opened).toEqual([]);
  }
  await show(false);
  await ask();
  await show(false, true);
  await show(true);
  expect(opened).toEqual([]);
});
