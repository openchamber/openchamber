import { describe, it, expect } from 'vitest';
import {
  adfToPlainText,
  buildJiraIssuePrompt,
  buildJiraIssueUrl,
  buildJiraSessionTitle,
} from './issue-context.js';

const baseIssue = {
  key: 'ABC-42',
  fields: {
    summary: 'Login button unresponsive on Safari',
    description: 'Steps:\n1. Open login page\n2. Click login',
    status: { name: 'To Do' },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    labels: ['frontend', 'safari'],
    components: [{ name: 'auth' }],
    reporter: { displayName: 'Rita Reporter' },
    assignee: { displayName: 'Dev Dana' },
    project: { key: 'ABC', name: 'Acme Core' },
    comment: {
      comments: [
        { author: { displayName: 'Rita Reporter' }, created: '2026-08-01T10:00:00.000+0000', body: 'Also happens on iOS.' },
      ],
    },
    issuelinks: [
      { type: { outward: 'blocks' }, outwardIssue: { key: 'ABC-43', fields: { summary: 'Release 2.0' } } },
    ],
  },
};

describe('buildJiraIssuePrompt', () => {
  it('includes key, summary, metadata, description, links, and comments', () => {
    const prompt = buildJiraIssuePrompt({ issue: baseIssue, baseUrl: 'https://acme.atlassian.net' });
    expect(prompt).toContain('# ABC-42: Login button unresponsive on Safari');
    expect(prompt).toContain('Issue link: https://acme.atlassian.net/browse/ABC-42');
    expect(prompt).toContain('- Type: Bug');
    expect(prompt).toContain('- Status: To Do');
    expect(prompt).toContain('- Priority: High');
    expect(prompt).toContain('- Project: ABC — Acme Core');
    expect(prompt).toContain('- Labels: frontend, safari');
    expect(prompt).toContain('- Components: auth');
    expect(prompt).toContain('1. Open login page');
    expect(prompt).toContain('- blocks ABC-43: Release 2.0');
    expect(prompt).toContain('Also happens on iOS.');
    expect(prompt).toContain('## Instructions');
  });

  it('handles a missing description explicitly', () => {
    const issue = { ...baseIssue, fields: { ...baseIssue.fields, description: null, comment: null, issuelinks: [] } };
    const prompt = buildJiraIssuePrompt({ issue, baseUrl: 'https://acme.atlassian.net' });
    expect(prompt).toContain('_No description provided._');
    expect(prompt).not.toContain('## Comments');
    expect(prompt).not.toContain('## Linked issues');
  });

  it('truncates oversized descriptions', () => {
    const issue = { ...baseIssue, fields: { ...baseIssue.fields, description: 'x'.repeat(10_000) } };
    const prompt = buildJiraIssuePrompt({ issue, baseUrl: 'https://acme.atlassian.net' });
    expect(prompt).toContain('… (truncated)');
    expect(prompt.length).toBeLessThan(10_000);
  });

  it('flattens ADF descriptions instead of printing objects', () => {
    const issue = {
      ...baseIssue,
      fields: {
        ...baseIssue.fields,
        description: {
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'ADF body text' }] },
          ],
        },
      },
    };
    const prompt = buildJiraIssuePrompt({ issue, baseUrl: 'https://acme.atlassian.net' });
    expect(prompt).toContain('ADF body text');
    expect(prompt).not.toContain('[object Object]');
  });

  it('caps the number of included comments and says so', () => {
    const comments = Array.from({ length: 9 }, (_, i) => ({
      author: { displayName: `User ${i}` },
      created: '2026-08-01T10:00:00.000+0000',
      body: `Comment ${i}`,
    }));
    const issue = { ...baseIssue, fields: { ...baseIssue.fields, comment: { comments } } };
    const prompt = buildJiraIssuePrompt({ issue, baseUrl: 'https://acme.atlassian.net' });
    expect(prompt).toContain('## Recent comments (5 of 9)');
    expect(prompt).toContain('Comment 8');
    expect(prompt).not.toContain('Comment 0');
  });
});

describe('adfToPlainText', () => {
  it('joins nested block content with newlines', () => {
    const text = adfToPlainText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    expect(text).toBe('one\ntwo\n');
  });

  it('tolerates junk input', () => {
    expect(adfToPlainText(null)).toBe('');
    expect(adfToPlainText(42)).toBe('');
    expect(adfToPlainText('plain')).toBe('plain');
  });
});

describe('buildJiraSessionTitle', () => {
  it('builds "KEY: summary" and bounds the length', () => {
    expect(buildJiraSessionTitle(baseIssue)).toBe('ABC-42: Login button unresponsive on Safari');
    const long = { key: 'ABC-1', fields: { summary: 'y'.repeat(300) } };
    expect(buildJiraSessionTitle(long).length).toBeLessThanOrEqual(120);
  });

  it('falls back to the key alone', () => {
    expect(buildJiraSessionTitle({ key: 'ABC-1', fields: {} })).toBe('ABC-1');
  });
});

describe('buildJiraIssueUrl', () => {
  it('builds browse links', () => {
    expect(buildJiraIssueUrl('https://acme.atlassian.net', 'ABC-1')).toBe('https://acme.atlassian.net/browse/ABC-1');
  });
});
