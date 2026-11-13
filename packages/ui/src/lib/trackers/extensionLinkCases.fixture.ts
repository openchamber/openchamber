/**
 * An extension's link templates, what the host compiles each into, and the
 * links each then names (null: not an item link). One table for the server's
 * compiler and matcher (`server/lib/trackers/extension-descriptor.test.js`)
 * and the UI's matcher over the served patterns (`matchTrackerUrl.test.ts`):
 * the UI never sees a template, so the compiled strings are pinned here and
 * both sides are held to them.
 */
type ExtensionIdentifierKind = 'key-number' | 'number' | 'short-code';

export const EXTENSION_IDENTIFIER_PATTERNS = {
  'key-number': '^[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}$',
  number: '^\\d{1,16}$',
  'short-code': '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
} satisfies Record<ExtensionIdentifierKind, string>;

export const EXTENSION_LINK_HOST = 'tracker.example.com';

type ExtensionLinkCase = {
  template: string;
  identifier: ExtensionIdentifierKind;
  compiled: { path: string; query?: { name: string } };
  /** Links on `EXTENSION_LINK_HOST` and elsewhere, with the identifier each names. */
  urls: ReadonlyArray<readonly [url: string, identifier: string | null]>;
};

const KEY = '([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})';

export const EXTENSION_LINK_CASES: readonly ExtensionLinkCase[] = [
  {
    template: '/browse/{id}',
    identifier: 'key-number',
    compiled: { path: `^/browse/${KEY}(?:/|$)` },
    urls: [
      ['https://tracker.example.com/browse/proj-7', 'PROJ-7'],
      ['https://www.tracker.example.com/browse/PROJ-7/', 'PROJ-7'],
      ['https://tracker.example.com/browse/PROJ-7/comments?focus=1#c2', 'PROJ-7'],
      ['https://tracker.example.com/browse/7', null],
      ['https://tracker.example.com/browse/PROJ-7x', null],
      ['https://tracker.example.com/browsex/PROJ-7', null],
      ['https://other.example.com/browse/PROJ-7', null],
      ['https://tracker.example.com.evil.test/browse/PROJ-7', null],
      ['ftp://tracker.example.com/browse/PROJ-7', null],
      ['PROJ-7', null],
    ],
  },
  {
    template: '/_workitems/edit/{id}',
    identifier: 'number',
    compiled: { path: '^/_workitems/edit/(\\d{1,16})(?:/|$)' },
    urls: [
      ['https://tracker.example.com/_workitems/edit/42', '42'],
      ['https://tracker.example.com/_workitems/edit/42/', '42'],
      ['https://tracker.example.com/_workitems/edit/42abc', null],
      ['https://tracker.example.com/_workitems/edit/', null],
    ],
  },
  {
    template: '/c/{id}/{segment}',
    identifier: 'short-code',
    compiled: { path: '^/c/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/[^/]{1,256}(?:/|$)' },
    urls: [
      ['https://tracker.example.com/c/AbC123/some-title', 'ABC123'],
      ['https://tracker.example.com/c/AbC123/some-title/extra', 'ABC123'],
      ['https://tracker.example.com/c/AbC123', null],
      ['https://tracker.example.com/c/AbC123/', null],
    ],
  },
  {
    template: '/{segments+}/issue/{id}',
    identifier: 'key-number',
    compiled: { path: `^/[^/]{1,256}(?:/[^/]{1,256}){0,19}/issue/${KEY}(?:/|$)` },
    urls: [
      ['https://tracker.example.com/a/b/issue/KEY-1', 'KEY-1'],
      ['https://tracker.example.com/org/issue/key-1/title', 'KEY-1'],
      ['https://tracker.example.com/issue/KEY-1', null],
    ],
  },
  {
    template: '/{segments+}?selectedIssue={id}',
    identifier: 'key-number',
    compiled: { path: '^/[^/]{1,256}(?:/[^/]{1,256}){0,19}(?:/|$)', query: { name: 'selectedIssue' } },
    urls: [
      ['https://tracker.example.com/jira/software/projects/OPS/boards/1?selectedIssue=ops-7', 'OPS-7'],
      ['https://tracker.example.com/jira/boards/1?other=1&selectedIssue=OPS-7', 'OPS-7'],
      ['https://tracker.example.com/jira/boards/1?selectedIssue=../etc', null],
      ['https://tracker.example.com/jira/boards/1?selectedIssue=', null],
      ['https://tracker.example.com/jira/boards/1', null],
      ['https://tracker.example.com/?selectedIssue=OPS-7', null],
    ],
  },
  {
    template: '/?issue={id}',
    identifier: 'key-number',
    compiled: { path: '^/$', query: { name: 'issue' } },
    urls: [
      ['https://tracker.example.com/?issue=KEY-9', 'KEY-9'],
      ['https://tracker.example.com?issue=key-9', 'KEY-9'],
      ['https://tracker.example.com/x?issue=KEY-9', null],
    ],
  },
];
