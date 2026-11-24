import { describe, expect, it } from 'vitest';
import { resolveResultDelivery } from './result-delivery.js';

const context = { ownWork: false, sessionID: 'ses_child', parentSessionID: 'ses_parent', session: null };

describe('resolveResultDelivery', () => {
  it('does not deliver a send that waits for the answer', async () => {
    const result = await resolveResultDelivery({ dispatchResults: {} }, 'session.send', { prompt: 'Again', wait: true }, context);

    expect(result).toBe(false);
  });

  it('resumes a send to the caller\'s ownWork child', async () => {
    const result = await resolveResultDelivery({ dispatchResults: {} }, 'session.send', { prompt: 'Again' }, {
      ...context,
      session: { metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_parent' } } },
    });

    expect(result).toBe(true);
  });

  it('does not resume a send to another parent\'s child', async () => {
    const result = await resolveResultDelivery({ dispatchResults: {} }, 'session.send', { prompt: 'Again' }, {
      ...context,
      session: { metadata: { openchamber: { kind: 'operator-child', parentID: 'ses_other' } } },
    });

    expect(result).toBe(false);
  });

  it('does not resume when the target record is unavailable', async () => {
    const result = await resolveResultDelivery({ dispatchResults: {} }, 'session.send', { prompt: 'Again' }, context);

    expect(result).toBe(false);
  });
});
