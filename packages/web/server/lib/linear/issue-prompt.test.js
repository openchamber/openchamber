import { describe, expect, it } from 'vitest';

import { buildIssuePrompt, buildIssueSessionTitle } from './issue-prompt.js';

const ISSUE = {
  id: 'issue-1',
  identifier: 'ENG-42',
  title: 'Login button unresponsive on mobile',
  description: 'Tapping the login button does nothing on iOS Safari.',
  url: 'https://linear.app/acme/issue/ENG-42/login-button',
  branchName: 'eng-42-login-button',
  priorityLabel: 'High',
  state: { name: 'Todo', type: 'unstarted' },
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  assignee: { name: 'Ada' },
  labels: { nodes: [{ name: 'bug' }, { name: 'openchamber' }] },
  comments: {
    nodes: [
      { body: 'Reproduced on iPhone 15.', user: { name: 'Grace' } },
      { body: '', user: { name: 'Empty' } },
    ],
  },
};

describe('buildIssueSessionTitle', () => {
  it('combines identifier and title', () => {
    expect(buildIssueSessionTitle(ISSUE)).toBe('ENG-42: Login button unresponsive on mobile');
  });

  it('truncates very long titles', () => {
    const title = buildIssueSessionTitle({ identifier: 'ENG-1', title: 'x'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back when the issue has no usable fields', () => {
    expect(buildIssueSessionTitle({})).toBe('Linear issue');
  });
});

describe('buildIssuePrompt', () => {
  it('includes identifier, metadata, description, and comments', () => {
    const prompt = buildIssuePrompt(ISSUE);
    expect(prompt).toContain('Linear issue ENG-42: Login button unresponsive on mobile');
    expect(prompt).toContain('Team: Engineering');
    expect(prompt).toContain('Labels: bug, openchamber');
    expect(prompt).toContain('Issue URL: https://linear.app/acme/issue/ENG-42/login-button');
    expect(prompt).toContain('Tapping the login button does nothing on iOS Safari.');
    expect(prompt).toContain('**Grace**:');
    expect(prompt).toContain('Reproduced on iPhone 15.');
  });

  it('handles a missing description explicitly', () => {
    const prompt = buildIssuePrompt({ identifier: 'ENG-1', title: 'No description' });
    expect(prompt).toContain('(no description provided)');
    expect(prompt).not.toContain('## Recent comments');
  });

  it('truncates oversized descriptions', () => {
    const prompt = buildIssuePrompt({
      identifier: 'ENG-1',
      title: 'Big',
      description: 'y'.repeat(20_000),
    });
    expect(prompt).toContain('…(truncated)');
    expect(prompt.length).toBeLessThan(15_000);
  });
});
