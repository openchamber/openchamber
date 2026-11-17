import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { JsonValue } from '@openchamber/sdk';
import { z } from 'zod';

import { createPageDriver, type JsonObject, type PageDialog } from './pageDriver';

/** Gives an element a box and opacity, which happy-dom does not lay out. */
const drawn = (element: { setAttribute: (name: string, value: string) => void }, box = { x: 10, y: 20, width: 100, height: 40 }): void => {
  element.setAttribute('style', 'opacity: 1');
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height }),
  });
};

/** A page script's answer: JSON, as the driver hands it over from the page. */
const run = async (win: Window, source: string): Promise<JsonValue> => z.json().parse(await new Function(
  'window', 'document', 'navigator', 'CSS', 'location', 'Event', 'KeyboardEvent', `return ${source}`,
)(win, win.document, win.navigator, win.CSS, win.location, win.Event, win.KeyboardEvent));

type Fake = {
  frames: { frameId: string; parentFrameId: string | null; url: string; win: Window; origin: { x: number; y: number } }[];
  steps: { op: string; args: JsonObject }[];
  dialog: PageDialog | null;
  /** A dialog the next input opens. */
  opensDialog: PageDialog | null;
};

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((win) => win.happyDOM.close()));
});

const page = (html: string, url = 'http://localhost:3000/'): Window => {
  const win = new Window({ url });
  win.document.body.innerHTML = html;
  windows.push(win);
  return win;
};

const fakeDriver = (fake: Fake) => createPageDriver({
  withInput: (step) => step(),
  // What the driver hands over is JSON, as over IPC.
  drive: async (op, args = {}) => z.json().parse(await fakeStep(fake, op, args)),
});

const fakeStep = async (fake: Fake, op: string, args: JsonObject) => {
    fake.steps.push({ op, args });
    const frame = fake.frames.find((entry) => entry.frameId === args.frameId);
    switch (op) {
      case 'frames':
        return fake.frames.map(({ frameId, parentFrameId, url }) => ({ frameId, parentFrameId, url }));
      case 'dialog':
        return fake.dialog;
      case 'evaluate':
        return { value: await run(frame!.win, String(args.expression)) };
      case 'frameOrigin':
        return frame!.origin;
      case 'click':
      case 'press':
      case 'insertText':
      case 'hover':
        if (fake.opensDialog) {
          fake.dialog = fake.opensDialog;
          return { dialog: fake.opensDialog };
        }
        return {};
      case 'answerDialog': {
        const answered = fake.dialog;
        fake.dialog = null;
        return { answered, accepted: args.accept ?? null };
      }
      default:
        throw new Error(`unexpected step ${op}`);
    }
};

const twoFrames = (): Fake => {
  const top = page('<button id="save">Save</button><iframe></iframe>');
  drawn(top.document.querySelector('#save')!);
  const inner = page('<button id="pay">Pay now</button>', 'https://pay.example/');
  drawn(inner.document.querySelector('#pay')!, { x: 5, y: 6, width: 20, height: 10 });
  return {
    frames: [
      { frameId: 'top', parentFrameId: null, url: 'http://localhost:3000/', win: top, origin: { x: 0, y: 0 } },
      { frameId: 'pay', parentFrameId: 'top', url: 'https://pay.example/', win: inner, origin: { x: 300, y: 400 } },
    ],
    steps: [],
    dialog: null,
    opensDialog: null,
  };
};

describe('page driver', () => {
  test('a snapshot lists every frame with refs, and frame elements carry page bounds and no selector', async () => {
    const fake = twoFrames();
    const snapshot = await fakeDriver(fake).snapshot({});

    expect(snapshot.elements).toMatchObject([
      { ref: 'e1', selector: '#save', label: 'Save' },
      { ref: 'e2', label: 'Pay now', frame: 'https://pay.example/', bounds: { x: 305, y: 406, width: 20, height: 10 } },
    ]);
    expect(z.array(z.object({ selector: z.string().optional() })).parse(snapshot.elements)[1].selector).toBeUndefined();
    expect(snapshot.text).toContain('[frame https://pay.example/]');
    expect(snapshot.frames).toEqual([{ url: 'https://pay.example/', elements: 1 }]);
  });

  test('a click by ref presses the element at its point in its own frame', async () => {
    const fake = twoFrames();
    const driver = fakeDriver(fake);
    await driver.snapshot({});

    expect(await driver.click({ ref: 'e2' })).toMatchObject({ clicked: true, ref: 'e2', label: 'Pay now' });
    expect(fake.steps.find((step) => step.op === 'click')?.args).toEqual({ frameId: 'pay', x: 15, y: 11 });
  });

  test('a click by label finds an exact match in a later frame before a partial one', async () => {
    const fake = twoFrames();
    fake.frames[0].win.document.body.insertAdjacentHTML('beforeend', '<button id="later">Pay now later</button>');
    drawn(fake.frames[0].win.document.querySelector('#later')!);

    await fakeDriver(fake).click({ text: 'pay now' });
    expect(fake.steps.find((step) => step.op === 'click')?.args).toEqual({ frameId: 'pay', x: 15, y: 11 });
  });

  test('a ref from before the last snapshot, or never listed, asks for a new snapshot', async () => {
    const fake = twoFrames();
    const driver = fakeDriver(fake);
    await expect(driver.click({ ref: 'e1' })).rejects.toThrow('Take a new browser.snapshot');

    await driver.snapshot({});
    fake.frames[0].win.document.querySelector('#save')!.remove();
    await expect(driver.click({ ref: 'e1' })).rejects.toThrow('e1 is not on the page any more');
  });

  test('a ref whose frame navigated away asks for a new snapshot', async () => {
    const fake = twoFrames();
    const driver = fakeDriver(fake);
    await driver.snapshot({});
    fake.frames.pop();

    await expect(driver.click({ ref: 'e2' })).rejects.toThrow('e2 is not on the page any more');
  });

  test('inspecting an element in a frame reports page bounds and the frame, with no selector', async () => {
    const fake = twoFrames();
    const driver = fakeDriver(fake);
    await driver.snapshot({});

    const result = await driver.inspect({ ref: 'e2' });
    expect(result).toMatchObject({ ref: 'e2', frame: 'https://pay.example/', bounds: { x: 305, y: 406, width: 20, height: 10 } });
    expect(result.selector).toBeUndefined();
  });

  test('typing replaces the field and reports what it holds', async () => {
    const fake = twoFrames();
    fake.frames[0].win.document.body.insertAdjacentHTML('beforeend', '<input id="q" value="old">');
    const result = await fakeDriver(fake).type({ selector: '#q', value: 'new', submit: true });

    expect(fake.steps.filter((step) => ['insertText', 'press'].includes(step.op)).map((step) => step.args)).toEqual([
      { text: 'new' },
      { key: 'Enter' },
    ]);
    // The fake inserts nothing, so the field still holds what it had.
    expect(result).toMatchObject({ typed: true, selector: '#q', value: 'old' });
  });

  test('a click that opens a dialog answers with it, and later actions refuse until it is answered', async () => {
    const fake = twoFrames();
    fake.opensDialog = { type: 'confirm', message: 'Delete it?', url: 'http://localhost:3000/' };
    const driver = fakeDriver(fake);

    expect(await driver.click({ selector: '#save' })).toMatchObject({ dialog: { type: 'confirm', message: 'Delete it?' } });
    await expect(driver.click({ selector: '#save' })).rejects.toThrow('confirm dialog saying "Delete it?"');
    expect(await driver.snapshot({})).toMatchObject({ dialog: { type: 'confirm' } });

    expect(await driver.answerDialog({ accept: true })).toMatchObject({ accepted: true });
    fake.opensDialog = null;
    expect(await driver.click({ selector: '#save' })).toMatchObject({ clicked: true });
  });

  test('a wait ends when the text shows in any frame, and says what never came', async () => {
    const fake = twoFrames();
    let clock = 0;
    const driver = fakeDriver(fake);
    const sleep = async (ms: number) => {
      clock += ms;
      if (clock >= 500) fake.frames[1].win.document.body.insertAdjacentHTML('beforeend', '<p>Payment done</p>');
    };

    expect(await driver.wait({ text: 'payment done' }, sleep, () => clock)).toEqual({ met: true, waitedMs: 500 });
    await expect(driver.wait({ text: 'Refunded', timeoutMs: 1_000 }, sleep, () => clock)).rejects.toThrow('the text "Refunded" did not show up');
  });
});
