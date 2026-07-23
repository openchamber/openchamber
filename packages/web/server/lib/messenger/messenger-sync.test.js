import { describe, expect, it } from 'vitest';
import { mergeProjectBindings } from './messenger-sync.js';

describe('mergeProjectBindings (per-server project sync)', () => {
  it('accumulates bindings across servers instead of replacing them', () => {
    // Server A synced project /proj into channel a1.
    const afterServerA = mergeProjectBindings(undefined, [
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
    expect(afterServerA).toEqual([
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);

    // Server B syncs the SAME project into a different channel b1 — the earlier
    // server's binding must survive so inbound routing keeps working for both.
    const afterServerB = mergeProjectBindings(afterServerA, [
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
    expect(afterServerB).toEqual([
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
  });

  it('does not shrink when a later save knows only the primary server', () => {
    const prev = [
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj' },
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ];
    // A frequent saveDiscordConfig only carries the primary channel a1.
    const merged = mergeProjectBindings(prev, [
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj (renamed)' },
    ]);
    // b1 preserved; a1 updated with the incoming label.
    expect(merged).toEqual([
      { channelId: 'a1', projectPath: '/proj', projectLabel: 'Proj (renamed)' },
      { channelId: 'b1', projectPath: '/proj', projectLabel: 'Proj' },
    ]);
  });

  it('dedupes by channelId and drops malformed entries', () => {
    const merged = mergeProjectBindings(
      [{ channelId: 'a1', projectPath: '/one' }],
      [
        { channelId: 'a1', projectPath: '/one-updated' },
        { channelId: '', projectPath: '/bad' },
        { projectPath: '/no-channel' },
        null,
      ],
    );
    expect(merged).toEqual([{ channelId: 'a1', projectPath: '/one-updated', projectLabel: undefined }]);
  });

  it('returns an empty list for empty input', () => {
    expect(mergeProjectBindings(undefined, undefined)).toEqual([]);
    expect(mergeProjectBindings(null, [])).toEqual([]);
  });
});
