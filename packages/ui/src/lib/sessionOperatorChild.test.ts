import { describe, expect, test } from 'bun:test';

import { isOperatorChildSession, metadataAfterTakeOver, operatorChildParentId, permissionsAfterTakeOver } from './sessionOperatorChild';
import type { Session } from './opencode/model';

const child = (metadata: Session['metadata']): Session => ({
  id: 'ses_child',
  projectID: 'proj_1',
  title: '',
  directory: '/repo',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata,
});

describe('operator child sessions', () => {
  test('reads the link the server writes and nothing else', () => {
    expect(operatorChildParentId({ openchamber: { kind: 'operator-child', parentID: 'ses_operator' } })).toBe('ses_operator');
    expect(isOperatorChildSession(child({ openchamber: { kind: 'operator-child', parentID: 'ses_operator' } }))).toBe(true);
    expect(isOperatorChildSession(child({ openchamber: { kind: 'workflow-agent', parentID: 'ses_run' } }))).toBe(false);
    expect(isOperatorChildSession(child(undefined))).toBe(false);
  });

  test('taking a session over drops the link, keeps the rest and puts it in work', () => {
    const metadata = { openchamber: { kind: 'operator-child', parentID: 'ses_operator', workTitle: { title: 'Parser', by: 'user' } }, other: { kept: true } };
    expect(metadataAfterTakeOver(metadata, 42)).toEqual({
      openchamber: { workTitle: { title: 'Parser', by: 'user' }, work: { state: 'open', openedAt: 42, openedBy: 'user' } },
      other: { kept: true },
    });
  });

  test('taking a session over gives the question and secret tools back and keeps every other rule', () => {
    const rules = [
      { action: 'bash', resource: '*', effect: 'ask' as const },
      { action: 'question', resource: '*', effect: 'deny' as const },
      { action: 'question', resource: 'x', effect: 'deny' as const },
      { action: 'openchamber_secret', resource: '*', effect: 'deny' as const },
    ];
    expect(permissionsAfterTakeOver(rules)).toEqual([rules[0], rules[2]]);
    expect(permissionsAfterTakeOver(undefined)).toEqual([]);
  });
});
