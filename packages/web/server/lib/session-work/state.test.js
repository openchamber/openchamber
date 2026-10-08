import { describe, expect, it } from 'vitest';
import { clearSuggestionPatch, openByJevPatch, readWork, offerReviewPatch, suggestDonePatch } from './state.js';

const withWork = (work) => ({ openchamber: { goal: { id: 'g' }, work } });

describe('session work state', () => {
  it('reads a work record, and a missing or malformed one as none', () => {
    expect(readWork(withWork({ state: 'open', openedAt: 1 }))).toMatchObject({ state: 'open' });
    expect(readWork({})).toBeNull();
    expect(readWork(withWork({ state: 'maybe' }))).toBeNull();
  });

  it('opens a session that is not in work and records that Jev did it', () => {
    expect(openByJevPatch({}, { requestAt: 5, now: 10 })).toEqual({
      openchamber: { work: { state: 'open', openedAt: 10, openedBy: 'jev', doneAt: null, suggestDoneAt: null } },
    });
    expect(openByJevPatch(withWork({ state: 'open', openedAt: 1 }), { requestAt: 5, now: 10 })).toBeNull();
  });

  it('reopens a closed session only for a request sent after the user closed it', () => {
    const closedAt7 = withWork({ state: 'done', doneAt: 7 });
    expect(openByJevPatch(closedAt7, { requestAt: 5, now: 10 })).toBeNull();
    expect(openByJevPatch(closedAt7, { requestAt: 7, now: 10 })).toBeNull();
    expect(openByJevPatch(closedAt7, { requestAt: 8, now: 10 })).toMatchObject({ openchamber: { work: { state: 'open' } } });
  });

  it('hints done only on a session in work, and retires the hint once', () => {
    expect(suggestDonePatch(withWork({ state: 'open' }), { now: 3 })).toEqual({ openchamber: { work: { suggestDoneAt: 3 } } });
    expect(suggestDonePatch(withWork({ state: 'done' }), { now: 3 })).toBeNull();
    expect(suggestDonePatch({}, { now: 3 })).toBeNull();
    expect(clearSuggestionPatch(withWork({ state: 'open', suggestDoneAt: 3 }))).toEqual({ openchamber: { work: { suggestDoneAt: null } } });
    expect(clearSuggestionPatch(withWork({ state: 'open' }))).toBeNull();
  });

  it('offers a review on any session, and a new turn retires both hints', () => {
    expect(offerReviewPatch({}, { now: 3 })).toEqual({ openchamber: { reviewOffer: { at: 3 } } });
    expect(clearSuggestionPatch({ openchamber: { reviewOffer: { at: 3 } } })).toEqual({ openchamber: { reviewOffer: null } });
    expect(clearSuggestionPatch({ openchamber: { work: { state: 'open', suggestDoneAt: 3 }, reviewOffer: { at: 3 } } }))
      .toEqual({ openchamber: { work: { suggestDoneAt: null }, reviewOffer: null } });
  });
});
