import { beforeEach, describe, expect, test } from 'bun:test';
import type { LinearAPI, LinearIssueLiveSummary, LinearIssueSummariesResult } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useLinearIssueStateStore } from './useLinearIssueStateStore';

const unreachable = () => Promise.reject(new Error('not used in this test'));
const linearApi = (issueSummaries: LinearAPI['issueSummaries']): LinearAPI => ({
  authStatus: unreachable,
  authStart: unreachable,
  authDisconnect: unreachable,
  authActivate: unreachable,
  issuesList: unreachable,
  issueGet: unreachable,
  issueStates: unreachable,
  issueSummaries,
  issueUpdate: unreachable,
  mappingGet: unreachable,
  mappingSet: unreachable,
  sessionStatusPost: unreachable,
  preferencesGet: unreachable,
  preferencesSet: unreachable,
});

const issue = (identifier: string, type: LinearIssueLiveSummary['state']['type'] = 'started'): LinearIssueLiveSummary => ({
  identifier, title: `Title ${identifier}`, state: { name: 'In Progress', type },
});

const stateOf = (identifier: string) => useLinearIssueStateStore.getState().summaries[`${getRuntimeKey()}|${identifier}`] ?? null;

describe('linked Linear issue states', () => {
  beforeEach(() => useLinearIssueStateStore.getState().resetForRuntimeSwitch());

  test('asks once per cadence, case-insensitively, and keeps the answers', async () => {
    const asked: string[][] = [];
    const linear = linearApi(async (identifiers) => {
      asked.push(identifiers);
      return { connected: true, issues: identifiers.map((identifier) => issue(identifier)) };
    });

    await useLinearIssueStateStore.getState().sync(['eng-1', 'ENG-1', 'ENG-2'], linear, 60_000);
    await useLinearIssueStateStore.getState().sync(['ENG-1', 'ENG-2'], linear, 60_000);

    expect(asked).toEqual([['ENG-1', 'ENG-2']]);
    expect(stateOf('ENG-1')?.state.type).toBe('started');
  });

  test('an issue the workspace no longer answers for loses its state; a failure keeps it', async () => {
    let answer: () => Promise<LinearIssueSummariesResult> = async () => ({ connected: true, issues: [issue('ENG-1'), issue('ENG-2')] });
    const linear = linearApi(() => answer());
    await useLinearIssueStateStore.getState().sync(['ENG-1', 'ENG-2'], linear, 0);

    answer = async () => { throw new Error('offline'); };
    await useLinearIssueStateStore.getState().sync(['ENG-1', 'ENG-2'], linear, 0);
    expect(stateOf('ENG-1')).not.toBeNull();

    answer = async () => ({ connected: true, issues: [issue('ENG-2', 'completed')] });
    await useLinearIssueStateStore.getState().sync(['ENG-1', 'ENG-2'], linear, 0);
    expect(stateOf('ENG-1')).toBeNull();
    expect(stateOf('ENG-2')?.state.type).toBe('completed');
  });

  test('a disconnected answer writes nothing', async () => {
    await useLinearIssueStateStore.getState().sync(['ENG-1'], linearApi(async () => ({ connected: false })), 0);
    expect(useLinearIssueStateStore.getState().summaries).toEqual({});
  });

  test('what is asked during a request is sent right after it', async () => {
    const asked: string[][] = [];
    let release: () => void = () => {};
    const linear = linearApi(async (identifiers) => {
      asked.push(identifiers);
      if (asked.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { connected: true, issues: identifiers.map((identifier) => issue(identifier)) };
    });

    const first = useLinearIssueStateStore.getState().sync(['ENG-1'], linear, 0);
    await useLinearIssueStateStore.getState().sync(['ENG-9'], linear, 0);
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(asked).toEqual([['ENG-1'], ['ENG-9']]);
    expect(stateOf('ENG-9')).not.toBeNull();
  });
});
