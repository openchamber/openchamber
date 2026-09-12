import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { copyTextToClipboard } from './clipboard';

const descriptors = ['navigator', 'document'].map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }));
afterEach(() => {
  for (const { name, descriptor } of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('copyTextToClipboard operation scope', () => {
  test('skips a cancelled operation before asking to write to the clipboard', async () => {
    let writes = 0;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { writes += 1; } } } });
    const result = await copyTextToClipboard('old selection', () => false);
    expect(result.ok).toBe(false);
    expect(writes).toBe(0);
  });

  test('skips execCommand when a clipboard permission rejection arrives after cancellation', async () => {
    const dom = new Window();
    let fallbackWrites = 0;
    let current = true;
    let rejectWrite: (reason: Error) => void = () => undefined;
    const permission = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: () => permission } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document });
    Object.defineProperty(dom.document, 'execCommand', { value: () => { fallbackWrites += 1; return true; } });
    const result = copyTextToClipboard('old selection', () => current);
    current = false;
    rejectWrite(new DOMException('Denied', 'NotAllowedError'));
    expect((await result).ok).toBe(false);
    expect(fallbackWrites).toBe(0);
    expect(dom.document.querySelector('textarea')).toBeNull();
    dom.happyDOM.abort();
  });
});
