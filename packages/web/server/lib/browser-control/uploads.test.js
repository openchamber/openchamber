import { describe, expect, test } from 'bun:test';

import { createUploadStore } from './uploads.js';

describe('upload store', () => {
  test('answers the files of a live upload by index, and nothing after two minutes', () => {
    let clock = 0;
    const store = createUploadStore({ now: () => clock });
    const file = { name: 'a.png', path: '/p/a.png', size: 3, bytes: Buffer.from('png') };
    const { token, files } = store.put([file]);

    expect(files).toEqual([{ name: 'a.png', size: 3 }]);
    expect(store.get(token, 0)).toBe(file);
    expect(store.get(token, 1)).toBeNull();
    expect(store.get('other', 0)).toBeNull();

    clock = 2 * 60 * 1000;
    expect(store.get(token, 0)).toBeNull();
  });
});
