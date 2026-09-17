import { describe, expect, test } from 'bun:test';

import { guestCommandEntries } from './commands.ts';
import type { InstalledGuest } from './types.ts';

const guest = (id: string, names: string[], overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  commands: names.map((name) => ({ name })),
  ...overrides,
});

describe('guestCommandEntries', () => {
  test('lists active guests only, first guest wins a name, reserved names lose', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => { warnings.push(message); };
    try {
      const entries = guestCommandEntries([
        guest('a', ['task', 'summary']),
        guest('b', ['task', 'pr']),
        guest('paused', ['link'], { enabled: false }),
        guest('pending', ['todo'], { capabilities: { requested: ['prompt'], granted: [] } }),
      ], new Set(['summary']));
      expect(entries.map((entry) => `${entry.guestId}/${entry.command.name}`)).toEqual(['a/task', 'b/pr']);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('/summary');
      expect(warnings[1]).toContain('/task');

      // A second pass warns nothing new for the same collisions.
      guestCommandEntries([guest('a', ['task', 'summary']), guest('b', ['task', 'pr'])], new Set(['summary']));
      expect(warnings).toHaveLength(2);
    } finally {
      console.warn = originalWarn;
    }
  });
});
