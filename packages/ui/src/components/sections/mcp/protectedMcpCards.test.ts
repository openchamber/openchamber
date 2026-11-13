import { describe, expect, test } from 'bun:test';
import type { ProtectedConnection, ProtectedMcpStatus } from './protectedMcp';
import { hasProtectedSelections, orphanActions, orphanedSelections, protectedCards, selectionActions } from './protectedMcpCards';

const connection = (id: string, name: string): ProtectedConnection => ({
  id, name, revision: 1, enabled: true, transport: 'stdio', target: { kind: 'command', label: name }, credential: 'stored',
});

type Selections = Record<string, { connection: string; disabled?: true }>;

const status = (global: Selections, project: Selections | null): ProtectedMcpStatus => {
  const effective: Selections = {};
  for (const [name, entry] of Object.entries(global)) if (!entry.disabled) effective[name] = entry;
  for (const [name, entry] of Object.entries(project ?? {})) {
    if (entry.disabled) delete effective[name];
    else effective[name] = entry;
  }
  return {
    host: { supported: true },
    service: { state: 'not_installed' },
    selections: { global, project, effective },
    selectionsError: null,
  };
};

const github = connection('pmcp_00000000000000a1', 'precocerto-github');
const other = connection('pmcp_00000000000000b2', 'other-github');
const plain = connection('pmcp_00000000000000c3', 'sentry');

const summary = (cards: ReturnType<typeof protectedCards>) => cards.map((card) => [card.connection.name, card.name, card.use, card.global, card.project]);

describe('protected connection cards', () => {
  test('a migrated selection shows its connection in use under the selection\'s name', () => {
    const cards = protectedCards(status({}, { github: { connection: github.id } }), [github, plain]);
    expect(summary(cards)).toEqual([
      ['precocerto-github', 'github', 'project', false, true],
      ['sentry', 'sentry', 'unused', false, false],
    ]);
  });

  test('a name this project gives to another connection turns the global one off here', () => {
    const cards = protectedCards(status({ github: { connection: github.id } }, { github: { connection: other.id } }), [github, other]);
    expect(summary(cards)).toEqual([
      ['precocerto-github', 'github', 'off-here', true, true],
      ['other-github', 'github', 'project', false, true],
    ]);
  });

  test('a name turned off in this project stays tied to its connection', () => {
    const cards = protectedCards(status({ sentry: { connection: plain.id } }, { sentry: { connection: plain.id, disabled: true } }), [plain]);
    expect(summary(cards)).toEqual([['sentry', 'sentry', 'off-here', true, true]]);
  });

  test('a connection selected under two names gets a card for each', () => {
    const cards = protectedCards(status({ github: { connection: github.id } }, { 'github-work': { connection: github.id } }), [github]);
    expect(summary(cards)).toEqual([
      ['precocerto-github', 'github', 'global', true, false],
      ['precocerto-github', 'github-work', 'project', false, true],
    ]);
  });

  test('selections of connections the service no longer has are listed by name', () => {
    const current = status({ gone: { connection: 'pmcp_ffffffffffffffff' }, github: { connection: github.id } }, null);
    expect(orphanedSelections(current, [github])).toEqual([{ name: 'gone', global: true, project: false, use: 'global' }]);
    expect(summary(protectedCards(current, [github]))).toEqual([['precocerto-github', 'github', 'global', true, false]]);
  });

  test('a removed connection turned off in this project still gets a card, with both entries removable', () => {
    const gone = 'pmcp_ffffffffffffffff';
    const current = status({ github: { connection: gone } }, { github: { connection: gone, disabled: true } });
    expect(orphanedSelections(current, [plain])).toEqual([{ name: 'github', global: true, project: true, use: 'off-here' }]);
  });

  test('a host without the service keeps the section while only turned-off stale entries remain', () => {
    const gone = 'pmcp_ffffffffffffffff';
    const current = status({ github: { connection: gone, disabled: true } }, { sentry: { connection: gone, disabled: true } });
    expect(current.selections?.effective).toEqual({});
    expect(hasProtectedSelections(current)).toBe(true);
    expect(orphanedSelections(current, []).map((orphan) => orphan.name)).toEqual(['github', 'sentry']);
    expect(hasProtectedSelections(status({}, {}))).toBe(false);
    expect(hasProtectedSelections(status({}, null))).toBe(false);
  });

  test('only the stale entry of a name is offered for removal', () => {
    const current = status({ github: { connection: github.id } }, { github: { connection: 'pmcp_ffffffffffffffff' } });
    expect(orphanedSelections(current, [github])).toEqual([{ name: 'github', global: false, project: true, use: 'project' }]);
    expect(summary(protectedCards(current, [github]))).toEqual([['precocerto-github', 'github', 'off-here', true, true]]);
  });
});

describe('card actions', () => {
  const PROJECT = '/work/project';
  const actionsOf = (current: ProtectedMcpStatus, directory: string | null, connections = [github]) =>
    protectedCards(current, connections).map((card) => selectionActions(card, directory).map(({ id, name, request }) => [id, name, request]));

  test('a connection used in all projects can be turned off here or stopped everywhere', () => {
    expect(actionsOf(status({ github: { connection: github.id } }, null), PROJECT)).toEqual([[
      ['turn-off-here', 'github', { method: 'PUT', body: { scope: 'project', connection: github.id, disabled: true } }],
      ['stop-everywhere', 'github', { method: 'DELETE', body: { scope: 'global' } }],
    ]]);
  });

  test('without a project, a global connection can only be stopped everywhere', () => {
    expect(actionsOf(status({ github: { connection: github.id } }, null), null)).toEqual([[
      ['stop-everywhere', 'github', { method: 'DELETE', body: { scope: 'global' } }],
    ]]);
  });

  test('a connection used in this project can follow the choice for all projects', () => {
    expect(actionsOf(status({}, { github: { connection: github.id } }), PROJECT)).toEqual([[
      ['reset-here', 'github', { method: 'DELETE', body: { scope: 'project' } }],
    ]]);
  });

  test('a connection turned off here can be used again, reset, or stopped everywhere', () => {
    expect(actionsOf(status({ github: { connection: github.id } }, { github: { connection: github.id, disabled: true } }), PROJECT)).toEqual([[
      ['use-everywhere', 'github', { method: 'PUT', body: { scope: 'global', connection: github.id } }],
      ['use-here', 'github', { method: 'PUT', body: { scope: 'project', connection: github.id } }],
      ['reset-here', 'github', { method: 'DELETE', body: { scope: 'project' } }],
      ['stop-everywhere', 'github', { method: 'DELETE', body: { scope: 'global' } }],
    ]]);
  });

  test('an unused connection is offered under its own name, here only with a project', () => {
    expect(actionsOf(status({}, null), PROJECT, [plain])).toEqual([[
      ['use-everywhere', 'sentry', { method: 'PUT', body: { scope: 'global', connection: plain.id } }],
      ['use-here', 'sentry', { method: 'PUT', body: { scope: 'project', connection: plain.id } }],
    ]]);
    expect(actionsOf(status({}, null), null, [plain])).toEqual([[
      ['use-everywhere', 'sentry', { method: 'PUT', body: { scope: 'global', connection: plain.id } }],
    ]]);
  });

  test('stopping everywhere is the only destructive action, and labels come from the action keys', () => {
    const [card] = protectedCards(status({ github: { connection: github.id } }, { github: { connection: github.id, disabled: true } }), [github]);
    if (!card) throw new Error('expected a card');
    expect(selectionActions(card, PROJECT).map(({ id, labelKey, icon, destructive }) => [id, labelKey, icon, destructive ?? false])).toEqual([
      ['use-everywhere', 'settings.mcp.protected.action.useEverywhere', 'global', false],
      ['use-here', 'settings.mcp.protected.action.useHere', 'folder', false],
      ['reset-here', 'settings.mcp.protected.action.resetHere', 'arrow-go-back', false],
      ['stop-everywhere', 'settings.mcp.protected.action.stopEverywhere', 'close', true],
    ]);
  });

  test('an orphaned name offers removing only its stale entries', () => {
    const gone = 'pmcp_ffffffffffffffff';
    const summaryOf = (current: ProtectedMcpStatus, connections: ProtectedConnection[]) =>
      orphanedSelections(current, connections).map((orphan) => orphanActions(orphan).map(({ id, name, request }) => [id, name, request]));
    expect(summaryOf(status({ github: { connection: gone } }, { github: { connection: gone, disabled: true } }), [])).toEqual([[
      ['reset-here', 'github', { method: 'DELETE', body: { scope: 'project' } }],
      ['stop-everywhere', 'github', { method: 'DELETE', body: { scope: 'global' } }],
    ]]);
    expect(summaryOf(status({ github: { connection: github.id } }, { github: { connection: gone } }), [github])).toEqual([[
      ['reset-here', 'github', { method: 'DELETE', body: { scope: 'project' } }],
    ]]);
  });
});
