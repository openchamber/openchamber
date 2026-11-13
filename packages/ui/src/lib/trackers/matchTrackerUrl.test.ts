import { describe, expect, test } from 'bun:test';

import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from './descriptor.fixture';
import { LINEAR_URL_CASES } from './linearUrlCases.fixture';
import { EXTENSION_IDENTIFIER_PATTERNS, EXTENSION_LINK_CASES, EXTENSION_LINK_HOST } from './extensionLinkCases.fixture';
import { createTrackerUrlMatcher } from './matchTrackerUrl';

describe('createTrackerUrlMatcher', () => {
  const match = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);

  // The same table the server's `matchLinearUrl` follows.
  for (const [url, identifier] of LINEAR_URL_CASES) {
    test(`reads ${JSON.stringify(url)} as ${identifier ?? 'no item'}`, () => {
      expect(match(url)).toEqual(identifier ? { provider: 'linear', identifier } : null);
    });
  }

  test('reads each tracker through its own patterns, in registry order', () => {
    const both = createTrackerUrlMatcher([linearLikeTrackerDescriptor(), acmeTrackerDescriptor()]);
    expect(both('https://tickets.example.com/t/OPS-7')).toEqual({ provider: 'acme-tickets', identifier: 'OPS-7' });
    expect(both('https://linear.app/openchamber/issue/ENG-1')).toEqual({ provider: 'linear', identifier: 'ENG-1' });
  });

  test('reads the identifier from the query parameter a pattern names, checked against the identifier shape', () => {
    // What the host compiles from an extension's `/{segments+}?selectedIssue={id}` template.
    const jira = createTrackerUrlMatcher([acmeTrackerDescriptor({
      id: 'ext-jira',
      urlPatterns: [
        { host: 'jira.example.com', path: '^/browse/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' },
        { host: 'jira.example.com', path: '^/(?:[^/]+/)*[^/]+(?:/|$)', query: { name: 'selectedIssue' } },
      ],
      identifierPattern: '^[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}$',
    })]);
    expect(jira('https://jira.example.com/jira/software/projects/OPS/boards/1?selectedIssue=ops-7')).toEqual({ provider: 'ext-jira', identifier: 'OPS-7' });
    expect(jira('https://jira.example.com/browse/OPS-7')).toEqual({ provider: 'ext-jira', identifier: 'OPS-7' });
    // A query value that is not an identifier, or a missing parameter, is no item.
    expect(jira('https://jira.example.com/jira/software/projects/OPS/boards/1?selectedIssue=../etc')).toBeNull();
    expect(jira('https://jira.example.com/jira/software/projects/OPS/boards/1')).toBeNull();
  });

  test('matches nothing without served trackers, and skips a pattern that does not compile', () => {
    expect(createTrackerUrlMatcher([])('https://linear.app/openchamber/issue/ENG-1')).toBeNull();
    const broken = createTrackerUrlMatcher([linearLikeTrackerDescriptor({ urlPatterns: [{ host: 'linear.app', path: '([' }] })]);
    expect(broken('https://linear.app/openchamber/issue/ENG-1')).toBeNull();
  });
});

describe('createTrackerUrlMatcher over an extension\'s compiled templates', () => {
  // The same table the server's compiler and matcher are held to.
  for (const { template, identifier, compiled, urls } of EXTENSION_LINK_CASES) {
    const match = createTrackerUrlMatcher([acmeTrackerDescriptor({
      id: 'ext-table', urlPatterns: [{ host: EXTENSION_LINK_HOST, ...compiled }], identifierPattern: EXTENSION_IDENTIFIER_PATTERNS[identifier],
    })]);
    for (const [url, expected] of urls) {
      test(`${template}: reads ${JSON.stringify(url)} as ${expected ?? 'no item'}`, () => {
        expect(match(url)).toEqual(expected ? { provider: 'ext-table', identifier: expected } : null);
      });
    }
  }
});
