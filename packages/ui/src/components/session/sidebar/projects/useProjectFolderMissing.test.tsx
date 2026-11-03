import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { opencodeClient } from '@/lib/opencode/client';
import { useFolderMissing } from './useProjectFolderMissing';

type Availability = 'available' | 'missing' | 'unknown';

describe('useFolderMissing', () => {
  const DOM_GLOBALS = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = DOM_GLOBALS.map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }));
  let win: Window;
  let root: Root;
  const answers = new Map<string, Availability>();
  let result: ReturnType<typeof useFolderMissing>;
  const probe = spyOn(opencodeClient, 'getDirectoryAvailability');

  const Probe = ({ directory }: { directory: string | undefined }) => {
    result = useFolderMissing(directory);
    return null;
  };
  const show = (directory: string | undefined) => act(async () => root.render(<Probe directory={directory} />));

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    for (const [name, value] of Object.entries({ window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    answers.clear();
    probe.mockImplementation(async (directory) => answers.get(directory) ?? 'unknown');
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    for (const { name, descriptor } of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await win.happyDOM.close();
    probe.mockReset();
  });

  test('a confirmed-missing folder is missing; an unknown answer proves nothing', async () => {
    answers.set('/gone', 'missing');
    await show('/gone');
    expect(result.missing).toBe(true);
    await show('/unreachable');
    expect(result.missing).toBe(false);
  });

  test('another session\'s folder does not show this one\'s answer', async () => {
    answers.set('/gone', 'missing').set('/here', 'available');
    await show('/gone');
    await show('/here');
    expect(result.missing).toBe(false);
    await show('/gone');
    expect(result.missing).toBe(true);
  });

  test('a folder that came back clears on the next look, and only then', async () => {
    answers.set('/gone', 'missing');
    await show('/gone');
    answers.set('/gone', 'available');
    expect(result.missing).toBe(true);
    await act(async () => result.recheck());
    expect(result.missing).toBe(false);
  });

  test('an unknown answer keeps what is known', async () => {
    answers.set('/gone', 'missing');
    await show('/gone');
    answers.clear();
    await act(async () => result.recheck());
    expect(result.missing).toBe(true);
  });

  test('a folder confirmed by the probe holds sends', async () => {
    answers.set('/gone', 'missing');
    await show('/gone');
    expect(result.confirmed).toBe(true);
    await act(async () => result.clearSendMark());
    expect(result.missing).toBe(true);
  });

  test('a refused send marks a folder the probe cannot see, without holding the next send', async () => {
    await show('/no-probe');
    expect(result.missing).toBe(false);
    await act(async () => result.markMissing());
    expect(result.missing).toBe(true);
    expect(result.confirmed).toBe(false);
    await act(async () => result.recheck());
    expect(result.missing).toBe(true);
    await act(async () => result.clearSendMark());
    expect(result.missing).toBe(false);
  });

  test('a late answer for the previous folder changes nothing', async () => {
    let answerFirst = (_value: Availability) => {};
    probe.mockImplementation((directory) => (directory === '/first'
      ? new Promise<Availability>((resolve) => { answerFirst = resolve; })
      : Promise.resolve('missing')));
    await show('/first');
    await show('/second');
    expect(result.missing).toBe(true);
    await act(async () => answerFirst('available'));
    expect(result.missing).toBe(true);
    await act(async () => answerFirst('missing'));
    await show('/first');
    expect(result.missing).toBe(false);
  });

  test('no folder is never missing', async () => {
    await show(undefined);
    expect(result.missing).toBe(false);
    expect(probe.mock.calls.length).toBe(0);
  });
});
