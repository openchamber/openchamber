import { describe, expect, test } from 'bun:test';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { createTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { isSameRepositoryItemLink, trackerItemLabel, trackerTargetOfUrl } from './openTrackerItem';

const urls = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor()], []);
const trackers = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);
const noTrackers = createTrackerUrlMatcher([]);

describe('trackerTargetOfUrl', () => {
  test('names what a link opens as', () => {
    expect(trackerTargetOfUrl('https://github.com/openchamber/openchamber/pull/4500', urls, trackers)).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerTargetOfUrl('https://github.com/openchamber/openchamber/issues/4483', urls, trackers)).toEqual({ source: 'repository', kind: 'issue' });
    expect(trackerTargetOfUrl('https://gitlab.com/group/sub/app/-/merge_requests/7', urls, trackers)).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerTargetOfUrl('https://gitlab.com/group/sub/app/-/issues/3', urls, trackers)).toEqual({ source: 'repository', kind: 'issue' });
    expect(trackerTargetOfUrl('https://linear.app/openchamber/issue/ope-282/some-title', urls, trackers)).toEqual({ source: 'tracker', provider: 'linear', identifier: 'OPE-282' });
  });

  test('leaves anything else to the browser', () => {
    expect(trackerTargetOfUrl('#12', urls, trackers)).toBeNull();
    expect(trackerTargetOfUrl('https://example.com/tickets/12', urls, trackers)).toBeNull();
    expect(trackerTargetOfUrl('https://github.com/openchamber/openchamber', urls, trackers)).toBeNull();
  });
});

describe('isSameRepositoryItemLink', () => {
  test('matches the item a link names, whatever page of it the link opens', () => {
    const pull = 'https://github.com/BendingSpoons/athena/pull/2553';
    expect(isSameRepositoryItemLink(pull, 'https://github.com/bendingspoons/athena/pull/2553/files', urls)).toBe(true);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/BendingSpoons/athena/issues/2553', urls)).toBe(true);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/BendingSpoons/athena/pull/2566', urls)).toBe(false);
    expect(isSameRepositoryItemLink(pull, 'https://github.com/other/athena/pull/2553', urls)).toBe(false);
  });

  test('tells GitLab issues and merge requests apart', () => {
    const request = 'https://gitlab.com/group/app/-/merge_requests/7';
    expect(isSameRepositoryItemLink(request, 'https://gitlab.com/group/app/-/merge_requests/7/diffs', urls)).toBe(true);
    expect(isSameRepositoryItemLink(request, 'https://gitlab.com/group/app/-/issues/7', urls)).toBe(false);
    expect(isSameRepositoryItemLink('#7', '#7', urls)).toBe(false);
  });
});

describe('trackerItemLabel', () => {
  test('names a tab the way its host numbers the item', () => {
    expect(trackerItemLabel('https://github.com/openchamber/openchamber/pull/4500/files', urls, trackers)).toBe('#4500');
    expect(trackerItemLabel('https://gitlab.com/group/app/-/merge_requests/7', urls, trackers)).toBe('!7');
    expect(trackerItemLabel('https://gitlab.com/group/app/-/issues/7', urls, trackers)).toBe('#7');
    expect(trackerItemLabel('https://linear.app/openchamber/issue/ope-282/some-title', urls, trackers)).toBe('OPE-282');
    expect(trackerItemLabel('https://example.com/tickets/12', urls, trackers)).toBeNull();
  });
});

describe('tracker links', () => {
  test('a tracker link is the tracker\'s only while the server serves that tracker', () => {
    const link = 'https://linear.app/openchamber/issue/ope-282/some-title';
    expect(trackerTargetOfUrl(link, urls, noTrackers)).toBeNull();
    expect(trackerItemLabel(link, urls, noTrackers)).toBeNull();
  });

  test('a tracker the UI has no code for opens and labels through its served patterns', () => {
    const acme = createTrackerUrlMatcher([linearLikeTrackerDescriptor(), acmeTrackerDescriptor()]);
    expect(trackerTargetOfUrl('https://tickets.example.com/t/OPS-7', urls, acme)).toEqual({ source: 'tracker', provider: 'acme-tickets', identifier: 'OPS-7' });
    expect(trackerItemLabel('https://tickets.example.com/t/OPS-7', urls, acme)).toBe('OPS-7');
  });
});

describe('a provider the UI has no code for', () => {
  const acme = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor(), acmeDescriptor()], []);

  test('opens, labels and compares its links through its own patterns', () => {
    const link = 'https://forge.example.com/team/tool/pulls/9';
    expect(trackerTargetOfUrl(link, acme, trackers)).toEqual({ source: 'repository', kind: 'pull' });
    expect(trackerItemLabel(link, acme, trackers)).toBe('#9');
    expect(isSameRepositoryItemLink(link, 'https://forge.example.com/Team/Tool/pulls/9/files', acme)).toBe(true);
    // Without its descriptor the link is nobody's.
    expect(trackerTargetOfUrl(link, urls, trackers)).toBeNull();
  });
});
