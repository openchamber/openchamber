import { describe, expect, test } from 'bun:test';
import { extractBodyBase64, extractBodyText } from './requestBodyTransport';

const decodeBase64Text = (value: string | undefined): string => {
  expect(typeof value).toBe('string');
  const binary = atob(value ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

describe('VS Code webview request body transport', () => {
  test('preserves body from SDK-style Request objects', async () => {
    const request = new Request('https://openchamber.local/api/session/abc/prompt_async', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'msg_1' }),
    });

    expect(decodeBase64Text(await extractBodyBase64(request, undefined, 'POST'))).toBe('{"messageID":"msg_1"}');
    expect(await request.text()).toBe('{"messageID":"msg_1"}');
  });

  test('preserves string, URLSearchParams, Blob, ArrayBuffer, typed array, and FormData bodies', async () => {
    const cases: Array<{ name: string; init: RequestInit; expected: string | RegExp }> = [
      { name: 'string', init: { body: 'plain text' }, expected: 'plain text' },
      { name: 'URLSearchParams', init: { body: new URLSearchParams({ a: '1', b: 'two' }) }, expected: 'a=1&b=two' },
      { name: 'Blob', init: { body: new Blob(['blob text'], { type: 'text/plain' }) }, expected: 'blob text' },
      { name: 'ArrayBuffer', init: { body: new TextEncoder().encode('array buffer').buffer }, expected: 'array buffer' },
      { name: 'typed array', init: { body: new Uint8Array(new TextEncoder().encode('typed array')) }, expected: 'typed array' },
    ];

    for (const entry of cases) {
      const encoded = await extractBodyBase64('https://openchamber.local/api/test', entry.init, 'POST');
      expect(decodeBase64Text(encoded)).toBe(entry.expected);
    }

    const form = new FormData();
    form.set('messageID', 'msg_1');
    form.set('file', new Blob(['file contents'], { type: 'text/plain' }), 'test.txt');
    const encodedForm = await extractBodyBase64('https://openchamber.local/api/upload', { body: form }, 'POST');
    const decodedForm = decodeBase64Text(encodedForm);
    expect(decodedForm).toContain('name="messageID"');
    expect(decodedForm).toContain('msg_1');
    expect(decodedForm).toContain('filename="test.txt"');
    expect(decodedForm).toContain('file contents');
  });

  test('extracts text for direct session message bridge bodies', async () => {
    expect(await extractBodyText('https://openchamber.local/api/session/abc/message', { body: new URLSearchParams({ q: 'hello' }) }, 'POST'))
      .toBe('q=hello');
  });
});
