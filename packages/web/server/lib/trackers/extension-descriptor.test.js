import { describe, expect, it } from 'vitest';

import { buildExtensionTrackerDescriptor, compileTrackerUrlTemplate, createDescriptorUrlMatcher, identifierPatternOf } from './extension-descriptor.js';
import { EXTENSION_IDENTIFIER_PATTERNS, EXTENSION_LINK_CASES, EXTENSION_LINK_HOST } from '../../../../ui/src/lib/trackers/extensionLinkCases.fixture.ts';

const contribution = {
  wire: 1,
  label: 'YouTrack',
  instances: { kind: 'user', label: 'Server address' },
  auth: { token: { header: 'authorization', scheme: 'bearer' }, oauth: { authorizeUrl: '/hub/api/rest/oauth2/auth', tokenUrl: '/hub/api/rest/oauth2/token' } },
  capabilities: { multipleAccounts: false, stateUpdate: true, children: false, labels: true, priority: false, filters: { people: true, priority: false }, projectMapping: true, sessionComments: true },
  stateFilters: ['open', 'all', 'todo', 'in-progress', 'done', 'inReview'],
  identifier: 'key-number',
  urls: { item: ['/issue/{id}', '/{segments+}/issue/{id}', '/agiles/{segment}/current?issue={id}'] },
};

describe('compileTrackerUrlTemplate', () => {
  it('compiles literal segments, the placeholders and the identifier shape into a bounded pattern', () => {
    expect(compileTrackerUrlTemplate('/browse/{id}', 'key-number')).toEqual({ path: '^/browse/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' });
    expect(compileTrackerUrlTemplate('/_workitems/edit/{id}', 'number')).toEqual({ path: '^/_workitems/edit/(\\d{1,16})(?:/|$)' });
    expect(compileTrackerUrlTemplate('/c/{id}/{segment}', 'short-code')).toEqual({ path: '^/c/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/[^/]{1,256}(?:/|$)' });
    expect(compileTrackerUrlTemplate('/{segments+}/issue/{id}', 'key-number').path).toBe('^/[^/]{1,256}(?:/[^/]{1,256}){0,19}/issue/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)');
    expect(compileTrackerUrlTemplate('/{segments+}?selectedIssue={id}', 'key-number')).toEqual({ path: '^/[^/]{1,256}(?:/[^/]{1,256}){0,19}(?:/|$)', query: { name: 'selectedIssue' } });
    expect(compileTrackerUrlTemplate('/?issue={id}', 'key-number')).toEqual({ path: '^/$', query: { name: 'issue' } });
    // A literal with regex syntax matches itself only.
    expect(new RegExp(compileTrackerUrlTemplate('/a.b/{id}', 'number').path).test('/axb/1')).toBe(false);
  });

  it('refuses what the manifest parse refuses, in the host\'s own words', () => {
    for (const template of ['browse/{id}', '/browse', '/browse/{id}/{id}', '/{segments+}/{segments+}/{id}', '/browse/(.*)', '/browse/{id}?x={id}', '/../{id}']) {
      expect(() => compileTrackerUrlTemplate(template, 'key-number')).toThrow(/link template|query template/);
    }
    expect(() => compileTrackerUrlTemplate('/browse/{id}', 'uuid')).toThrow(/identifier shape/);
  });
});

describe('buildExtensionTrackerDescriptor', () => {
  it('names the tracker ext-<guestId>, keeps host access off and compiles the links against the instance', () => {
    const descriptor = buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution, instance: 'https://www.yt.example.com' });
    expect(descriptor).toMatchObject({
      id: 'ext-youtrack',
      name: 'YouTrack',
      authMethods: ['oauth', 'token'],
      capabilities: { stateUpdate: true, labels: true, projectMapping: true, sessionComments: true, hostAccess: false, multipleAccounts: false, filters: { people: true, priority: false } },
      stateFilters: contribution.stateFilters,
      identifierPattern: identifierPatternOf('key-number'),
    });
    expect(descriptor.urlPatterns).toEqual([
      { host: 'yt.example.com', path: '^/issue/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' },
      { host: 'yt.example.com', path: '^/[^/]{1,256}(?:/[^/]{1,256}){0,19}/issue/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' },
      { host: 'yt.example.com', path: '^/agiles/[^/]{1,256}/current(?:/|$)', query: { name: 'issue' } },
    ]);
    expect(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.urlPatterns)).toBe(true);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
  });

  it('carries no link pattern while a user-typed server is not connected, and uses a fixed origin as is', () => {
    expect(buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution, instance: null }).urlPatterns).toEqual([]);
    const fixed = buildExtensionTrackerDescriptor({
      guestId: 'jira', instance: null,
      contribution: { ...contribution, label: 'Jira', instances: { kind: 'fixed', origin: 'https://acme.atlassian.net' }, urls: { item: ['/browse/{id}', '/{segments+}?selectedIssue={id}'] } },
    });
    expect(fixed.urlPatterns.map((pattern) => pattern.host)).toEqual(['acme.atlassian.net', 'acme.atlassian.net']);
    expect(fixed.authMethods).toEqual(['oauth', 'token']);
  });

  it('refuses a contribution the host cannot serve', () => {
    expect(() => buildExtensionTrackerDescriptor({ guestId: 'a'.repeat(29), contribution, instance: null })).toThrow(/cannot name a provider/);
    expect(() => buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution: { ...contribution, wire: 2 }, instance: null })).toThrow(/wire/);
    expect(() => buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution: { ...contribution, auth: {} }, instance: null })).toThrow(/sign in/);
    expect(() => buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution: { ...contribution, urls: { item: [] } }, instance: null })).toThrow(/link templates/);
    expect(() => buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution: { ...contribution, urls: { item: ['/browse/(.*)'] } }, instance: null })).toThrow(/Tracker contribution of youtrack is invalid: link template/);
  });
});

describe('createDescriptorUrlMatcher', () => {
  const match = createDescriptorUrlMatcher(buildExtensionTrackerDescriptor({ guestId: 'youtrack', contribution, instance: 'https://yt.example.com' }));

  it('reads the identifier from the path, from a prefixed path, or from the named query parameter, upper-cased', () => {
    expect(match('https://yt.example.com/issue/proj-42')).toBe('PROJ-42');
    expect(match('https://www.yt.example.com/issue/PROJ-42/Title-here')).toBe('PROJ-42');
    expect(match('https://yt.example.com/youtrack/issue/PROJ-42')).toBe('PROJ-42');
    expect(match('https://yt.example.com/agiles/123-4/current?issue=PROJ-7&x=1')).toBe('PROJ-7');
    expect(match('http://yt.example.com/issue/PROJ-42')).toBe('PROJ-42');
  });

  it('matches nothing off the host, off the templates, or with an identifier of another shape', () => {
    expect(match('https://other.example.com/issue/PROJ-42')).toBeNull();
    expect(match('https://yt.example.com/issues?query=PROJ-42')).toBeNull();
    expect(match('https://yt.example.com/agiles/123/current?issue=42')).toBeNull();
    expect(match('https://yt.example.com/issue/42')).toBeNull();
    expect(match('ftp://yt.example.com/issue/PROJ-42')).toBeNull();
    expect(match('not a url')).toBeNull();
    expect(match(42)).toBeNull();
  });
});

describe('the link table shared with the UI', () => {
  it('compiles every template to the pinned pattern, and the identifier shapes are the pinned ones', () => {
    for (const kind of Object.keys(EXTENSION_IDENTIFIER_PATTERNS)) expect(identifierPatternOf(kind)).toBe(EXTENSION_IDENTIFIER_PATTERNS[kind]);
    for (const { template, identifier, compiled } of EXTENSION_LINK_CASES) expect(compileTrackerUrlTemplate(template, identifier), template).toEqual(compiled);
  });

  it.each(EXTENSION_LINK_CASES.flatMap(({ template, identifier, compiled, urls }) => urls.map(([url, expected]) => [template, url, expected, identifier, compiled])))(
    '%s: matchUrl(%s) is %s',
    (_template, url, expected, identifier, compiled) => {
      const match = createDescriptorUrlMatcher({ identifierPattern: identifierPatternOf(identifier), urlPatterns: [{ host: EXTENSION_LINK_HOST, ...compiled }] });
      expect(match(url)).toBe(expected);
    },
  );
});
