import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LocalIssueError, appendComment, issueFileName, parseIssueFile, readIssue,
  sanitizeSlug, splitComments, writeIssue,
} from './files.js';

const SAMPLE = `---
identifier: LOCAL-7
title: Fix login
state: todo
priority: high
labels: [bug, ui]
assignee: null
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: null
blockedBy: []
extra-key: keep-me
---

Body text.
`;

const write = (dir, name, content) => { fs.writeFileSync(path.join(dir, name), content, 'utf8'); };

describe('sanitizeSlug', () => {
  it('lowercases, strips illegal characters and collapses dashes', () => {
    expect(sanitizeSlug('Fix Login! (v2)')).toBe('fix-login-v2');
  });
  it('falls back to issue for empty and prefixes Windows reserved names', () => {
    expect(sanitizeSlug('')).toBe('issue');
    expect(sanitizeSlug('CON')).toBe('issue-con');
    expect(sanitizeSlug('nul')).toBe('issue-nul');
  });
});

describe('parseIssueFile', () => {
  it('round-trips fields, unknown keys and body', () => {
    const issue = parseIssueFile(SAMPLE, 'LOCAL-7-fix-login.md');
    expect(issue.identifier).toBe('LOCAL-7');
    expect(issue.number).toBe(7);
    expect(issue.fields).toContainEqual(['extra-key', 'keep-me']);
    expect(issue.body).toContain('Body text.');
    expect(serializeRound(issue)).toContain('extra-key: keep-me');
    function serializeRound() { return `---\n${issue.fields.map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n${issue.body}`; }
  });
  it('rejects an identifier that does not match the file name', () => {
    expect(() => parseIssueFile(SAMPLE, 'LOCAL-8-x.md')).toThrow(LocalIssueError);
  });
  it('normalizes CRLF and a BOM', () => {
    const issue = parseIssueFile(`\uFEFF${SAMPLE.replace(/\n/g, '\r\n')}`, 'LOCAL-7-fix-login.md');
    expect(issue.body).toContain('Body text.');
    expect(issue.body.includes('\r')).toBe(false);
  });
});

describe('comments', () => {
  it('appends a comment and recreates the section in normalized form', () => {
    const issue = parseIssueFile(SAMPLE, 'LOCAL-7-fix-login.md');
    const withComment = appendComment(issue, { iso: '2026-11-01T09:00:00Z', source: 'session a1b2', text: 'completed in 12m' });
    const { head, comments } = splitComments(withComment.body);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ iso: '2026-11-01T09:00:00Z', source: 'session a1b2', text: 'completed in 12m' });
    expect(head).toContain('Body text.');
  });
  it('survives a mangled Comments section', () => {
    const mangled = `${SAMPLE}## Comments\ngarbage without headings\n`;
    const issue = appendComment(parseIssueFile(mangled, 'LOCAL-7-fix-login.md'), { iso: '2026-11-01T09:00:00Z', source: 'ui', text: 'hello' });
    expect(splitComments(issue.body).comments).toHaveLength(1);
    expect(issue.body).toContain('Body text.');
  });
});

describe('readIssue/writeIssue', () => {
  it('writes atomically and reads back, preserving unknown keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-local-'));
    writeIssue(dir, { fileName: 'LOCAL-1-x.md', number: 1, slug: 'x', identifier: 'LOCAL-1', fields: [['identifier', 'LOCAL-1'], ['title', 'T'], ['custom', 'c']], body: 'B\n' });
    expect(fs.existsSync(path.join(dir, 'LOCAL-1-x.md'))).toBe(true);
    const issue = readIssue(dir, 'LOCAL-1-x.md');
    expect(issue.fields).toContainEqual(['custom', 'c']);
    expect(readIssue(dir, 'nope.md')).toBeNull();
  });
  it('returns null for an unparseable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-local-'));
    write(dir, 'LOCAL-2-bad.md', 'no frontmatter here');
    expect(readIssue(dir, 'LOCAL-2-bad.md')).toBeNull();
  });
});

it('issueFileName matches the loader pattern', () => {
  expect(issueFileName(7, 'fix-login')).toMatch(/^LOCAL-7-[a-z0-9-]*\.md$/);
});
