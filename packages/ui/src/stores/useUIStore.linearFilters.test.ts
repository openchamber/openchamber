import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'url:https://instance-a';
const runtimeSwitch = await import('@/lib/runtime-switch');
mock.module('@/lib/runtime-switch', () => ({ ...runtimeSwitch, getRuntimeKey: () => runtimeKey }));

const { LINEAR_ISSUE_LIST_ALL_TEAMS, useUIStore } = await import('./useUIStore');

describe('linear issue list filters', () => {
  beforeEach(() => {
    runtimeKey = 'url:https://instance-a';
    useUIStore.setState({
      linearIssueListStatus: 'all',
      linearIssueListAssignee: 'any',
      linearIssueListTeamId: LINEAR_ISSUE_LIST_ALL_TEAMS,
      linearIssueListTeamIdByRuntime: {},
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

  test('keeps the team filter with the instance that owns the workspace', () => {
    useUIStore.getState().setLinearIssueListTeamId('team-eng');
    expect(useUIStore.getState().linearIssueListTeamId).toBe('team-eng');

    // Switching instances: a team belongs to one Linear workspace, so the new
    // instance opens on all teams rather than on a filter matching nothing.
    runtimeKey = 'url:https://instance-b';
    useUIStore.getState().applyLinearIssueListFiltersForRuntime();
    expect(useUIStore.getState().linearIssueListTeamId).toBe(LINEAR_ISSUE_LIST_ALL_TEAMS);

    useUIStore.getState().setLinearIssueListTeamId('team-ops');
    expect(useUIStore.getState().linearIssueListTeamId).toBe('team-ops');

    // Switching back restores the first instance's own choice.
    runtimeKey = 'url:https://instance-a';
    useUIStore.getState().applyLinearIssueListFiltersForRuntime();
    expect(useUIStore.getState().linearIssueListTeamId).toBe('team-eng');
  });

  test('a transient runtime key stores nothing and reads as all teams', () => {
    runtimeKey = 'mobile-disconnected';
    useUIStore.getState().setLinearIssueListTeamId('team-eng');

    expect(useUIStore.getState().linearIssueListTeamIdByRuntime).toEqual({});

    useUIStore.getState().applyLinearIssueListFiltersForRuntime();
    expect(useUIStore.getState().linearIssueListTeamId).toBe(LINEAR_ISSUE_LIST_ALL_TEAMS);
  });

  test('resetting filters clears the stored team for this instance only', () => {
    useUIStore.getState().setLinearIssueListTeamId('team-eng');
    runtimeKey = 'url:https://instance-b';
    useUIStore.getState().setLinearIssueListTeamId('team-ops');

    useUIStore.getState().resetLinearIssueListFilters();

    expect(useUIStore.getState().linearIssueListTeamIdByRuntime).toEqual({ 'url:https://instance-a': 'team-eng' });
  });
});
