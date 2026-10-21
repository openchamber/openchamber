import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopyLinkMenuHook } from './context-menu-clipboard.mjs';

class TestClipboardItem {
  constructor(data) {
    this.data = data;
  }
}

test('each menu copies its own destination and bookmark in one awaited write', async () => {
  const writes = [];
  const pending = Promise.withResolvers();
  const hook = createCopyLinkMenuHook({
    clipboard: { write: (items) => { writes.push(items); return pending.promise; } },
    ClipboardItem: TestClipboardItem,
    onError: () => assert.fail('unexpected copy failure'),
  });
  const first = {};
  const second = {};
  const properties = { linkURL: 'https://example.com/a%20b?q=one&x=two#section', linkText: 'Read this' };
  assert.deepEqual(hook({ copyLink: () => first }, properties), []);
  hook({ copyLink: () => second }, { linkURL: 'https://example.org/', linkText: 'Another link' });

  let settled = false;
  const copy = first.click().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(writes, [[new TestClipboardItem({
    'text/plain': properties.linkURL,
    'electron application/bookmark': { title: 'Read this', url: properties.linkURL },
  })]]);
  pending.resolve();
  await copy;
  await second.click();
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].data['text/plain'], 'https://example.org/');
});

for (const failure of ['construct', 'write', 'reject']) {
  test(`handles ${failure} failure once without exposing clipboard data`, async () => {
    const error = new Error('private clipboard URL');
    const reports = [];
    const item = {};
    const hook = createCopyLinkMenuHook({
      clipboard: {
        write: () => {
          if (failure === 'write') throw error;
          return Promise.reject(error);
        },
      },
      ClipboardItem: failure === 'construct' ? class {
        constructor() { throw error; }
      } : TestClipboardItem,
      onError: (...args) => reports.push(args),
    });
    hook({ copyLink: () => item }, { linkURL: 'https://example.com/private', linkText: 'Private' });
    await item.click();
    assert.deepEqual(reports, [[]]);
  });
}
