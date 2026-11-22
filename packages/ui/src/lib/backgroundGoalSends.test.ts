import { describe, expect, test } from 'bun:test';
import { createBackgroundSendJournal } from './backgroundGoalSends';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
};
const identity = (sessionId: string | null) => ({ runtimeKey: 'local', directory: '/repo', sessionId });

// Oracle: text conservation within a tab. A send is removed after delivery or
// restoration; a reload recovers its predecessor's entries exactly once.
// Separate session-storage instances cannot recover one another's live sends.
describe('background send journal', () => {
  test('keeps the text and mentions until the send settles', () => {
    const storage = memoryStorage();
    const journal = createBackgroundSendJournal({ storage, pageId: 'a' });
    const id = journal.record({ identity: identity('s1'), text: 'Ship it', mentions: ['src/a.ts', 'src/a.ts'] });
    expect(journal.takeOrphans()).toEqual([]);
    expect(journal.remove(id)).toMatchObject({ identity: identity('s1'), text: 'Ship it', mentions: ['src/a.ts'] });
    expect(journal.remove(id)).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test('a draft that becomes a session recovers to that session on reload', () => {
    const storage = memoryStorage();
    const before = createBackgroundSendJournal({ storage, pageId: 'before' });
    const id = before.record({ identity: identity(null), text: 'Ship it', mentions: [] });
    before.retarget(id, identity('created'));
    const after = createBackgroundSendJournal({ storage, pageId: 'after' });
    expect(after.takeOrphans()).toMatchObject([{ identity: identity('created'), text: 'Ship it' }]);
    expect(after.takeOrphans()).toEqual([]);
  });

  test('an unrelated tab cannot recover a live send, even if its timers stop', () => {
    const storage = memoryStorage();
    const holder = createBackgroundSendJournal({ storage, pageId: 'holder' });
    const other = createBackgroundSendJournal({ storage: memoryStorage(), pageId: 'other' });
    const id = holder.record({ identity: identity('s1'), text: 'Still generating', mentions: [] });
    expect(other.takeOrphans()).toEqual([]);
    expect(holder.takeOrphans()).toEqual([]);
    expect(holder.remove(id)?.text).toBe('Still generating');
  });

  test('a malformed entry does not discard a complete entry', () => {
    const storage = memoryStorage();
    storage.setItem('openchamber.backgroundGoalSends.v1', JSON.stringify([
      { id: 'broken' },
      { id: 'valid', pageId: 'before', identity: identity('s1'), text: 'Kept', mentions: [] },
    ]));
    const journal = createBackgroundSendJournal({ storage, pageId: 'after' });
    expect(journal.takeOrphans().map((entry) => entry.text)).toEqual(['Kept']);
  });

  test('generated send, retarget, settle and reload sequences conserve every message', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 300; run += 1) {
      const storage = memoryStorage();
      let page = 0;
      let journal = createBackgroundSendJournal({ storage, pageId: `p${page}` });
      const held = new Set<string>();
      const recorded: string[] = [];
      const returned: string[] = [];
      for (let step = 0; step < 40; step += 1) {
        const action = random();
        if (action < 0.4) {
          const text = `m${run}-${step}`;
          recorded.push(text);
          held.add(journal.record({ identity: identity(null), text, mentions: [] }));
        } else if (action < 0.6 && held.size > 0) {
          const [id] = held;
          journal.retarget(id, identity('created'));
        } else if (action < 0.8 && held.size > 0) {
          const [id] = held;
          const entry = journal.remove(id);
          held.delete(id);
          expect(entry).not.toBeNull();
          if (entry) returned.push(entry.text);
        } else {
          page += 1;
          journal = createBackgroundSendJournal({ storage, pageId: `p${page}` });
          returned.push(...journal.takeOrphans().map((entry) => entry.text));
          held.clear();
          expect(journal.takeOrphans()).toEqual([]);
        }
      }
      const finalPage = createBackgroundSendJournal({ storage, pageId: 'final' });
      returned.push(...finalPage.takeOrphans().map((entry) => entry.text));
      expect(returned.slice().sort()).toEqual(recorded.slice().sort());
      expect(storage.values.size).toBe(0);
    }
  });
});
