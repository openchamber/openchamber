import { describe, expect, test } from 'bun:test';
import { botAutomation, botSessionIds, botSessionOwner } from './sessionMetadata';
import { botSession } from './bots.fixture';
import { partitionSidebarSessions } from '@/components/session/sidebar/list/sessionCollection';

const metadata = { openchamber: { kind: 'scheduled', automation: { source: 'bot', projectId: 'project-1', botId: 'bot-1', itemId: 'item-1', stage: 'fixing' } } };

describe('bot session membership', () => {
  test('excludes bot roots and unmarked descendants from project and chat partitions', () => {
    // Given children precede their marked root and an unrelated scheduled session exists.
    const sessions = [botSession('child', { parentID: 'root' }), botSession('root', { metadata }), botSession('scheduled', { metadata: { openchamber: { kind: 'scheduled' } } })];

    // When the shared desktop/mobile partition is projected.
    const result = partitionSidebarSessions(sessions, false);

    // Then automation membership comes from the bot marker, including its descendants.
    expect(result.projectSessions.map((session) => session.id)).toEqual(['scheduled']);
    expect(result.chatSessions).toEqual([]);
  });

  test('re-evaluates same-ID metadata changes without retaining a former bot membership', () => {
    // Given a previously marked root loses its marker in an authoritative replacement.
    const previous = botSession('root', { metadata });
    const current = botSession('root');
    expect(botAutomation(previous)?.itemId).toBe('item-1');

    // When the replacement reaches the partition.
    const result = partitionSidebarSessions([current], false);

    // Then it becomes an ordinary project session again.
    expect(result.projectSessions.map((session) => session.id)).toEqual(['root']);
  });

  test('resolves a pending child to its bot owner across worktree directories', () => {
    // Given only the root has the bot metadata.
    const root = botSession('root', { metadata });
    const child = botSession('child', { parentID: root.id, directory: '/other' });

    // When a live pending request names the child.
    const owner = botSessionOwner(child.id, new Map([[root.id, root], [child.id, child]]));

    // Then the exact project and item are retained.
    expect(owner).toMatchObject({ projectId: 'project-1', itemId: 'item-1' });
  });

  test('terminates malformed parent cycles without inventing a bot owner', () => {
    // Given a cyclic hierarchy without an automation marker.
    const sessions = [botSession('a', { parentID: 'b' }), botSession('b', { parentID: 'a' })];

    // When membership and pending ownership are resolved.
    const ids = botSessionIds(sessions);
    const owner = botSessionOwner('a', new Map(sessions.map((session) => [session.id, session])));

    // Then neither result grants bot membership.
    expect(ids.size).toBe(0);
    expect(owner).toBeNull();
  });
});
