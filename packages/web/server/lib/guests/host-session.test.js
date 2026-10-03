import { describe, expect, test } from 'bun:test';

import { toGuestAuthResponse } from './host-session.js';

describe('toGuestAuthResponse', () => {
  test('leaves an oauth guest on the stored public slice', async () => {
    const published = await toGuestAuthResponse({
      name: 'GitLab',
      description: 'Issues',
      oauth: {
        authorizeUrl: 'https://gitlab.com/oauth/authorize',
        tokenUrl: 'https://gitlab.com/oauth/token',
        apiOrigin: 'https://gitlab.com',
      },
    }, {
      accessToken: 'tok',
      account: 'ada',
      clientId: 'app-1',
      // Entered for these endpoints, so the card still counts it as a client.
      clientTarget: { apiOrigin: 'https://gitlab.com', authorizeUrl: 'https://gitlab.com/oauth/authorize', tokenUrl: 'https://gitlab.com/oauth/token' },
      settings: { 'project-path': 'group/project' },
    });
    expect(published).toEqual({
      connected: true,
      account: 'ada',
      hasClient: true,
      settings: { 'project-path': 'group/project' },
    });
  });
});
