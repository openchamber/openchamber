import { describe, expect, test } from 'bun:test';
import { buildLinkedIssuesPatch, parseLinkOperation } from './session-linked-issues.js';

const issue = (overrides = {}) => ({
  id: 'owner/repo#12',
  number: 12,
  title: 'Rail badge count',
  url: 'https://github.com/owner/repo/issues/12',
  kind: 'issue',
  author: 'someone',
  linkedAt: 1,
  ...overrides,
});

const stored = { openchamber: { linked_issues: [issue()], goal: { status: 'active' } }, other: 1 };

describe('parseLinkOperation', () => {
  test('accepts one entry to link or unlink and keeps the snapshot fields', () => {
    const entry = { id: 'guest:linear:ENG-1', title: 'Spec', url: 'https://linear.app/x', kind: 'guest', thread: 'pull', data: { deep: true } };
    expect(parseLinkOperation({ entries: [entry], linked: true })).toEqual({ ok: true, entries: [entry], linked: true });
    expect(parseLinkOperation({ entries: [issue()], linked: false }).linked).toBe(false);
  });

  test('rejects what identity or the list cannot use', () => {
    expect(parseLinkOperation({ entries: [issue()], linked: 'yes' }).ok).toBe(false);
    expect(parseLinkOperation({ entries: issue(), linked: true }).ok).toBe(false);
    expect(parseLinkOperation({ entries: [{ ...issue(), id: '' }], linked: true }).ok).toBe(false);
    expect(parseLinkOperation({ entries: [{ ...issue(), title: undefined }], linked: true }).ok).toBe(false);
    expect(parseLinkOperation({ entries: [{ ...issue(), url: 7 }], linked: true }).ok).toBe(false);
    expect(parseLinkOperation({ entries: [{ ...issue(), kind: 'tweet' }], linked: true }).ok).toBe(false);
    expect(parseLinkOperation({ linked: true }).ok).toBe(false);
    expect(parseLinkOperation(undefined).ok).toBe(false);
  });
});

describe('buildLinkedIssuesPatch', () => {
  test('appending keeps the entries already on the record and the sibling metadata', () => {
    const patch = buildLinkedIssuesPatch(stored, [issue({ id: 'linear:ENG-1', number: undefined, url: 'https://linear.app/x', kind: 'linear' })], true);
    expect(patch.openchamber.linked_issues.map((entry) => entry.id)).toEqual(['owner/repo#12', 'linear:ENG-1']);
    expect(patch.openchamber.goal).toBeUndefined();
    // The patch carries only the list: the merge keeps the rest of the record.
    expect(Object.keys(patch.openchamber)).toEqual(['linked_issues']);
  });

  test('re-linking refreshes the entry and moves it to the end', () => {
    const other = issue({ id: 'owner/repo#7', number: 7, url: 'https://github.com/owner/repo/issues/7' });
    const metadata = { openchamber: { linked_issues: [issue(), other] } };
    const patch = buildLinkedIssuesPatch(metadata, [issue({ title: 'Rail badge count (fixed)' })], true);
    expect(patch.openchamber.linked_issues).toEqual([
      other,
      issue({ title: 'Rail badge count (fixed)' }),
    ]);
  });

  test('unlinking removes by id', () => {
    const patch = buildLinkedIssuesPatch(stored, [issue()], false);
    expect(patch.openchamber.linked_issues).toEqual([]);
  });

  test('a repository entry stored before ids carried the host is removed by kind, number and address', () => {
    const legacy = {
      id: 'team/repo#12',
      number: 12,
      title: 'Old',
      // Whitespace, a trailing slash and casing the writer did not normalize.
      url: ' https://GitLab.com/team/repo/-/issues/12/ ',
      kind: 'issue',
      linkedAt: 1,
    };
    const metadata = { openchamber: { linked_issues: [legacy] } };
    const unlink = buildLinkedIssuesPatch(metadata, [issue({ url: 'https://gitlab.com/team/repo/-/issues/12' })], false);
    expect(unlink.openchamber.linked_issues).toEqual([]);

    // The fallback never crosses kinds: a pull request with the same number
    // and address shape is a different thread, so unlinking it changes
    // nothing.
    const pull = buildLinkedIssuesPatch(
      metadata,
      [issue({ url: 'https://gitlab.com/team/repo/-/issues/12', kind: 'pull' })],
      false,
    );
    expect(pull).toBeNull();
  });

  test('an operation that changes nothing writes nothing', () => {
    expect(buildLinkedIssuesPatch(stored, [issue()], true)).toBeNull();
    expect(buildLinkedIssuesPatch({}, [issue()], false)).toBeNull();
    expect(buildLinkedIssuesPatch(stored, [], true)).toBeNull();
    // An entry already last, identical in every field: appending it again is
    // the same list.
    const last = { openchamber: { linked_issues: [issue()] } };
    expect(buildLinkedIssuesPatch(last, [issue()], true)).toBeNull();
  });

  test('a record without links is treated as an empty list', () => {
    expect(buildLinkedIssuesPatch({}, [issue()], true).openchamber.linked_issues).toEqual([issue()]);
    expect(buildLinkedIssuesPatch({ openchamber: {} }, [issue()], true).openchamber.linked_issues).toEqual([issue()]);
  });

  test('a batch applies every entry in one pass', () => {
    const second = issue({ id: 'owner/repo#13', number: 13, url: 'https://github.com/owner/repo/issues/13' });
    const patch = buildLinkedIssuesPatch(stored, [issue(), second, issue({ title: 'Again' })], true);
    expect(patch.openchamber.linked_issues).toEqual([second, issue({ title: 'Again' })]);
  });
});
