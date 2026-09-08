import { describe, expect, it } from 'vitest';
import { fetchUpdateNotes, renderUpdateNotes } from './update-notes.js';

const compare = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

const index = [
  { version: '1.2.3', date: '2026-03-03', title: 'Comments everywhere', intro: 'A short intro.', app: { new: ['**Comments:** on code.'], improvements: [], fixes: ['Chat: no freeze.'], misc: [] }, vscode: null },
  { version: '1.2.2', date: '2026-03-02', title: null, intro: null, app: { new: [], improvements: ['Faster.'], fixes: [], misc: [] }, vscode: null },
  { version: '1.2.1', date: '2026-03-01', title: 'Old', intro: null, app: { new: ['Older.'], improvements: [], fixes: [], misc: [] }, vscode: null },
];

describe('renderUpdateNotes', () => {
  it('renders the releases after the installed version up to the offered one, newest first', () => {
    expect(renderUpdateNotes(index, '1.2.1', '1.2.3', compare)).toBe(`## [1.2.3] - 2026-03-03

**Comments everywhere**

A short intro.

### New

- **Comments:** on code.

### Fixes

- Chat: no freeze.

## [1.2.2] - 2026-03-02

### Improvements

- Faster.`);
  });

  it('returns null when nothing lies in the range or the payload is not an index', () => {
    expect(renderUpdateNotes(index, '1.2.3', '1.2.3', compare)).toBe(null);
    expect(renderUpdateNotes({ entries: [] }, '1.0.0', '9.9.9', compare)).toBe(null);
    expect(renderUpdateNotes([{ version: 'nope' }, { version: '1.2.2', date: '2026' }], '1.0.0', '9.9.9', compare)).toBe(null);
  });
});

describe('fetchUpdateNotes', () => {
  it('turns a failed request or a thrown fetch into null', async () => {
    const notFound = async () => ({ ok: false });
    expect(await fetchUpdateNotes('1.0.0', '2.0.0', compare, { fetch: notFound })).toBe(null);
    const throwing = async () => { throw new Error('offline'); };
    expect(await fetchUpdateNotes('1.0.0', '2.0.0', compare, { fetch: throwing })).toBe(null);
  });

  it('renders a successful response', async () => {
    const ok = async () => ({ ok: true, json: async () => index });
    expect(await fetchUpdateNotes('1.2.2', '1.2.3', compare, { fetch: ok })).toMatch(/^## \[1\.2\.3\] - 2026-03-03\n\n\*\*Comments everywhere\*\*/);
  });
});
