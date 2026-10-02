import { expect, test } from 'bun:test';

import {
    composerReferenceKey,
    toContextReference,
    toLinkedIssue,
    withComposerReferences,
    withoutComposerReference,
    type ComposerReference,
} from './composerReferences';

const issue = (number: number, title = `Issue ${number}`): ComposerReference => ({
    kind: 'github-issue',
    number,
    title,
    url: `https://github.com/acme/app/issues/${number}`,
    contextText: `issue ${number}`,
});

const pull: ComposerReference = {
    kind: 'github-pr',
    number: 7,
    title: 'Fix login',
    url: 'https://github.com/acme/app/pull/7',
    head: 'fix/login',
    base: 'main',
    includeDiff: false,
    contextText: 'pr 7',
};

const linear: ComposerReference = { kind: 'linear-issue', identifier: 'ENG-3', title: 'Login', url: 'https://linear.app/x/issue/ENG-3', contextText: 'linear' };

const guest: ComposerReference = {
    kind: 'guest',
    providerId: 'jira',
    id: 'OPS-2',
    title: 'Ops',
    url: 'https://jira/OPS-2',
    contextText: 'jira',
    thread: 'issue',
    data: { status: 'open' },
};

test('references from every source sit side by side in attach order', () => {
    const list = withComposerReferences([issue(1)], [pull, linear, guest, issue(2)]);
    expect(list.map(composerReferenceKey)).toEqual([
        'github:https://github.com/acme/app/issues/1',
        'github:https://github.com/acme/app/pull/7',
        'linear:ENG-3',
        'guest:jira:OPS-2',
        'github:https://github.com/acme/app/issues/2',
    ]);
});

test('attaching an item again replaces it where it stands', () => {
    const withDiff = { ...pull, includeDiff: true, contextText: 'pr 7 with diff' };
    const list = withComposerReferences([issue(1), pull, linear], [withDiff, issue(1, 'Renamed')]);
    expect(list).toHaveLength(3);
    expect(list[1]).toEqual(withDiff);
    expect(list[0]).toMatchObject({ title: 'Renamed' });
});

test('removing one keeps the rest', () => {
    const list = withoutComposerReference([issue(1), pull, linear], composerReferenceKey(pull));
    expect(list.map(composerReferenceKey)).toEqual(['github:https://github.com/acme/app/issues/1', 'linear:ENG-3']);
});

test('a reference sends its text and identity, and a guest keeps its data', () => {
    expect(toContextReference(pull)).toEqual({ kind: 'github-pr', number: 7, title: 'Fix login', url: 'https://github.com/acme/app/pull/7', context: 'pr 7' });
    expect(toContextReference(guest)).toEqual({ kind: 'guest', providerId: 'jira', id: 'OPS-2', title: 'Ops', url: 'https://jira/OPS-2', contextText: 'jira', thread: 'issue', data: { status: 'open' } });
});

test('a sent reference becomes the session link the sidebar reads', () => {
    expect(toLinkedIssue(pull, 5)).toMatchObject({ id: 'acme/app#7', kind: 'pull', number: 7, linkedAt: 5 });
    expect(toLinkedIssue(issue(3), 5)).toMatchObject({ id: 'acme/app#3', kind: 'issue' });
    expect(toLinkedIssue(linear, 5)).toMatchObject({ id: 'linear:ENG-3', kind: 'linear' });
    expect(toLinkedIssue(guest, 5)).toMatchObject({ id: 'guest:jira:OPS-2', kind: 'guest', thread: 'issue', data: { status: 'open' } });
});
