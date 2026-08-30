import { beforeEach, describe, expect, test } from 'bun:test';
import { LINEAR_ISSUE_LIST_ALL_TEAMS, useUIStore } from './useUIStore';

describe('linear issue list filters', () => {
  beforeEach(() => {
    useUIStore.setState({
      linearIssueListStatus: 'all',
      linearIssueListAssignee: 'any',
      linearIssueListTeamId: LINEAR_ISSUE_LIST_ALL_TEAMS,
      linearIssueListPriority: 'all',
      linearIssueFocus: null,
    });
  });

  test('stores status, assignee, team, and priority across setter calls', () => {
    useUIStore.getState().setLinearIssueListStatus('todo');
    expect(useUIStore.getState().linearIssueListStatus).toBe('todo');
    useUIStore.getState().setLinearIssueListStatus('started');
    expect(useUIStore.getState().linearIssueListStatus).toBe('started');
    useUIStore.getState().setLinearIssueListStatus('inReview');
    expect(useUIStore.getState().linearIssueListStatus).toBe('inReview');
    useUIStore.getState().setLinearIssueListStatus('completed');
    expect(useUIStore.getState().linearIssueListStatus).toBe('completed');
    useUIStore.getState().setLinearIssueListStatus('canceled');
    expect(useUIStore.getState().linearIssueListStatus).toBe('canceled');
    useUIStore.getState().setLinearIssueListStatus('duplicate');
    expect(useUIStore.getState().linearIssueListStatus).toBe('duplicate');
    useUIStore.getState().setLinearIssueListStatus('backlog');
    expect(useUIStore.getState().linearIssueListStatus).toBe('backlog');
    useUIStore.getState().setLinearIssueListStatus('all');
    useUIStore.getState().setLinearIssueListAssignee('me');
    useUIStore.getState().setLinearIssueListTeamId('team-eng');
    useUIStore.getState().setLinearIssueListPriority('urgent');

    expect(useUIStore.getState().linearIssueListStatus).toBe('all');
    expect(useUIStore.getState().linearIssueListAssignee).toBe('me');
    expect(useUIStore.getState().linearIssueListTeamId).toBe('team-eng');
    expect(useUIStore.getState().linearIssueListPriority).toBe('urgent');
  });

  test('resets status, assignee, team, and priority together', () => {
    useUIStore.getState().setLinearIssueListStatus('todo');
    useUIStore.getState().setLinearIssueListAssignee('me');
    useUIStore.getState().setLinearIssueListTeamId('team-eng');
    useUIStore.getState().setLinearIssueListPriority('urgent');

    useUIStore.getState().resetLinearIssueListFilters();

    expect(useUIStore.getState().linearIssueListStatus).toBe('all');
    expect(useUIStore.getState().linearIssueListAssignee).toBe('any');
    expect(useUIStore.getState().linearIssueListTeamId).toBe(LINEAR_ISSUE_LIST_ALL_TEAMS);
    expect(useUIStore.getState().linearIssueListPriority).toBe('all');
  });

  test('treats a blank team id as all teams', () => {
    useUIStore.getState().setLinearIssueListTeamId('team-eng');
    useUIStore.getState().setLinearIssueListTeamId('   ');
    expect(useUIStore.getState().linearIssueListTeamId).toBe(LINEAR_ISSUE_LIST_ALL_TEAMS);
  });

  test('stores a one-shot Linear issue identifier for the rail panel', () => {
    useUIStore.getState().setLinearIssueFocus('  ENG-12  ');
    expect(useUIStore.getState().linearIssueFocus).toBe('ENG-12');
    useUIStore.getState().setLinearIssueFocus('   ');
    expect(useUIStore.getState().linearIssueFocus).toBeNull();
    useUIStore.getState().setLinearIssueFocus('ENG-12');
    useUIStore.getState().setLinearIssueFocus(null);
    expect(useUIStore.getState().linearIssueFocus).toBeNull();
  });
});
