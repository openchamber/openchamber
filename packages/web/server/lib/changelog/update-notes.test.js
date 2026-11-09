import { describe, expect, it } from 'vitest';
import { fetchReleaseNotes, fetchUpdateNotes, renderCanaryNotes, renderUpdateNotes } from './update-notes.js';
import { compareVersions } from '../version-order.js';

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

  it('shows SDK notes between Fixes and Misc and omits an empty SDK group', () => {
    const withSdk = [{
      ...index[0],
      app: { ...index[0].app, sdk: ['Actions: background execution.'], misc: ['Packaging update.'] },
    }];
    expect(renderUpdateNotes(withSdk, '1.2.2', '1.2.3', compare)).toContain(`### Fixes

- Chat: no freeze.

### SDK

- Actions: background execution.

### Misc

- Packaging update.`);
    expect(renderUpdateNotes([{ ...index[0], app: { sdk: [] } }], '1.2.2', '1.2.3', compare)).not.toContain('### SDK');
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

describe('release sources', () => {
  const apiFeed = {
    entries: [
      { version: '1.2.3', date: '2026-03-03', title: 'From the API', intro: null, groups: { new: ['Api.'], improvements: [], fixes: [], sdk: [], misc: [] } },
      { version: '1.2.2', date: '2026-03-02', title: null, intro: null, groups: null, notes: 'From a release body.' },
    ],
  };

  it('reads the website API first and skips entries without groups', async () => {
    const urls = [];
    const fetchApi = async (url) => { urls.push(url); return { ok: true, json: async () => apiFeed }; };
    expect(await fetchReleaseNotes('1.2.3', '1.2.1', compare, { fetch: fetchApi })).toEqual([
      { version: '1.2.3', date: '2026-03-03', title: 'From the API', intro: null, groups: [{ key: 'new', bullets: ['Api.'] }] },
    ]);
    expect(urls).toEqual(['https://api.openchamber.dev/v1/changelog/full']);
  });

  it('falls back to the index on GitHub when the API fails', async () => {
    const urls = [];
    const apiDown = async (url) => {
      urls.push(url);
      return url.includes('api.openchamber.dev') ? { ok: false } : { ok: true, json: async () => index };
    };
    expect((await fetchReleaseNotes('1.2.3', undefined, compare, { fetch: apiDown }))[0].title).toBe('Comments everywhere');
    expect(urls).toEqual(['https://api.openchamber.dev/v1/changelog/full', 'https://raw.githubusercontent.com/openchamber/openchamber/main/changelog/index.json']);
  });
});

describe('fetchReleaseNotes', () => {
  const ok = (entries) => async () => ({ ok: true, json: async () => entries });

  it('returns the installed release alone, with its empty groups dropped', async () => {
    expect(await fetchReleaseNotes('1.2.3', undefined, compare, { fetch: ok(index) })).toEqual([{
      version: '1.2.3',
      date: '2026-03-03',
      title: 'Comments everywhere',
      intro: 'A short intro.',
      groups: [{ key: 'new', bullets: ['**Comments:** on code.'] }, { key: 'fixes', bullets: ['Chat: no freeze.'] }],
    }]);
  });

  it('returns what an update brings, newest first, and the target alone on the way back', async () => {
    expect((await fetchReleaseNotes('1.2.3', '1.2.1', compare, { fetch: ok(index) })).map((release) => release.version)).toEqual(['1.2.3', '1.2.2']);
    expect((await fetchReleaseNotes('1.2.2', '1.2.3', compare, { fetch: ok(index) })).map((release) => release.version)).toEqual(['1.2.2']);
  });

  it('tells a release without notes from a source it could not read', async () => {
    expect(await fetchReleaseNotes('9.9.9', undefined, compare, { fetch: ok(index) })).toEqual([]);
    expect(await fetchReleaseNotes('1.2.3', undefined, compare, { fetch: async () => ({ ok: false }) })).toBe(null);
    expect(await fetchReleaseNotes('1.2.3', undefined, compare, { fetch: ok({ entries: [] }) })).toBe(null);
  });

  it('reads a Canary build from its night', async () => {
    const nights = [{ version: '2.5.4-canary.20261031.5', date: '2026-10-31', new: [{ area: 'chat', text: 'remember thinking level', pr: '5505' }], fixes: [] }];
    expect(await fetchReleaseNotes('2.5.4-canary.20261031.5', undefined, compareVersions, { fetch: ok(nights) })).toEqual([{
      version: '2.5.4-canary.20261031.5',
      date: '2026-10-31',
      title: null,
      intro: null,
      groups: [{ key: 'new', bullets: ['**Chat:** remember thinking level [#5505](https://github.com/openchamber/openchamber/pull/5505)'] }],
    }]);
  });
});

describe('Canary notes', () => {
  const nights = [
    { version: '2.5.4-canary.20261031.5', date: '2026-10-31', new: [{ area: 'chat', text: 'remember thinking level per model', pr: '5505' }], fixes: [{ area: 'scheduled-tasks', text: 'record dispatched runs as sent', pr: null }] },
    { version: '2.5.4-canary.20261030.4', date: '2026-10-30', new: [], fixes: [{ area: null, text: 'keep Chats one line', pr: '5924' }] },
    { version: '2.5.4-canary.20261029.3', date: '2026-10-29', new: [{ area: 'vscode', text: 'older night', pr: null }], fixes: [] },
  ];

  it('renders the nights after the installed build up to the offered one, newest first', () => {
    expect(renderCanaryNotes(nights, '2.5.4-canary.20261029.3', '2.5.4-canary.20261031.5', compareVersions)).toBe(`## [2.5.4-canary.20261031.5] - 2026-10-31

### New

- **Chat:** remember thinking level per model [#5505](https://github.com/openchamber/openchamber/pull/5505)

### Fixes

- **Scheduled tasks:** record dispatched runs as sent

## [2.5.4-canary.20261030.4] - 2026-10-30

### Fixes

- Keep Chats one line [#5924](https://github.com/openchamber/openchamber/pull/5924)`);
  });

  it('shows every kept night to a release build and none on the way back to Stable', () => {
    expect(renderCanaryNotes(nights, '2.5.3', '2.5.4-canary.20261031.5', compareVersions)).toContain('## [2.5.4-canary.20261029.3] - 2026-10-29\n\n### New\n\n- **VS Code:** older night');
    expect(renderCanaryNotes(nights, '2.5.4-canary.20261031.5', '2.5.4-canary.20261031.5', compareVersions)).toBe(null);
  });

  it('reads them from the R2 mirror for a Canary target', async () => {
    const urls = [];
    const ok = async (url) => { urls.push(url); return { ok: true, json: async () => nights }; };
    expect(await fetchUpdateNotes('2.5.4-canary.20261030.4', '2.5.4-canary.20261031.5', compareVersions, { fetch: ok })).toMatch(/^## \[2\.5\.4-canary\.20261031\.5\]/);
    expect(urls).toEqual(['https://downloads.openchamber.dev/desktop/canary/canary-notes.json']);
  });

  it('falls back to the canary pre-release when the mirror fails', async () => {
    const urls = [];
    const mirrorDown = async (url) => { urls.push(url); return url.includes('downloads.openchamber.dev') ? { ok: false } : { ok: true, json: async () => nights }; };
    expect(await fetchUpdateNotes('2.5.4-canary.20261030.4', '2.5.4-canary.20261031.5', compareVersions, { fetch: mirrorDown })).toMatch(/^## \[2\.5\.4-canary\.20261031\.5\]/);
    expect(urls.at(-1)).toBe('https://github.com/openchamber/openchamber/releases/download/canary/canary-notes.json');
  });
});
