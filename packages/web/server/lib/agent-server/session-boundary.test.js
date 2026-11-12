import { describe, expect, it } from 'vitest';
import { isAgentPayloadAllowed } from './session-boundary.js';

describe('agent session ownership boundary', () => {
  it.each([
    { directory: '/spaces/012345abcdef/repo' },
    { location: { directory: '/work/../spaces/012345abcdef/repo' } },
    { data: { location: { directory: '/spaces/012345abcdef/repo' } } },
    { properties: { info: { directory: '\\spaces\\012345abcdef\\repo' } } },
    { worktree: '/var/lib/openchamber-hostd/spaces/012345abcdef/repo' },
    { data: { sessionID: 'ses_space' } },
    { id: 'ses_space' },
    { modes: { ses_space: 'auto' } },
  ])('rejects consumed Space identity fields: %j', (payload) => {
    // Given an agent claiming a directory or known Space session through any consumed field.
    // When validated, then it cannot redirect UI or owner observers into that Space.
    expect(isAgentPayloadAllowed(payload, (id) => id === 'ses_space')).toBe(false);
  });
  it('allows ordinary locations and text mentioning a space', () => {
    // Given ordinary agent identity and a tool result quoting a path.
    const payload = { type: 'session.created', data: { sessionID: 'ses_agent', location: { directory: '/work/repo' }, text: '/spaces/example' } };
    // When validated, then display text is not mistaken for routing authority.
    expect(isAgentPayloadAllowed(payload)).toBe(true);
  });
});
