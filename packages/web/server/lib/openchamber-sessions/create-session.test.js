import { describe, expect, it, vi } from 'vitest';
import { createSession, OPERATOR_CHILD_NOTE_SOURCE } from './create-session.js';

const fakeClient = () => {
  const calls = [];
  return {
    calls,
    session: {
      create: vi.fn(async (input) => { calls.push(['create', input]); return { id: 'ses_new' }; }),
      synthetic: vi.fn(async (input) => { calls.push(['synthetic', input]); return {}; }),
    },
  };
};

describe('createSession', () => {
  it("creates an operator's child under its operator, without the question tool, and tells it nobody answers before any prompt", async () => {
    const client = fakeClient();
    const sessionID = await createSession({ client, directory: '/repo/wt', title: 'Parser', operatorParentId: 'ses_operator' });

    expect(sessionID).toBe('ses_new');
    expect(client.calls.map(([name]) => name)).toEqual(['create', 'synthetic']);
    expect(client.session.create).toHaveBeenCalledWith({
      location: { directory: '/repo/wt' },
      title: 'Parser',
      metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_operator' } },
      permissions: [{ action: 'question', resource: '*', effect: 'deny' }],
    });
    const note = client.session.synthetic.mock.calls[0][0];
    expect(note).toMatchObject({ sessionID: 'ses_new', resume: false, metadata: { source: OPERATOR_CHILD_NOTE_SOURCE, parentSessionID: 'ses_operator' } });
    expect(note.text).toContain('The user does not interact with this session');
    expect(note.text).toContain('openui-lang');
  });

  it('creates a session the user owns with no link, rule or note', async () => {
    const client = fakeClient();
    await createSession({ client, directory: '/repo', title: 'Mine', titleByUser: true });

    expect(client.session.create).toHaveBeenCalledWith({
      location: { directory: '/repo' },
      title: 'Mine',
      metadata: { openchamber: { workTitle: { title: 'Mine', by: 'user' } } },
    });
    expect(client.session.synthetic).not.toHaveBeenCalled();
  });

  it('keeps the child when the note cannot be admitted', async () => {
    const client = fakeClient();
    client.session.synthetic.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(createSession({ client, directory: '/repo', operatorParentId: 'ses_operator' })).resolves.toBe('ses_new');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
