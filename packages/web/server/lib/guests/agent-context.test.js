import { describe, expect, test } from 'vitest';

import { createGuestAgentContext, describeExtensionBlocks } from './agent-context.js';

const row = (overrides = {}) => ({
  id: 'desk',
  name: 'Desk',
  packageRoot: '/pkg',
  enabled: true,
  instructions: true,
  service: { entry: 'service/main.js', runtime: 'host' },
  skills: 'skills',
  capabilityGrants: ['service', 'instructions', 'skills'],
  blocks: [{ name: 'Chart', description: 'A chart', args: ['title', 'values'], entry: 'b.html' }],
  ...overrides,
});

const context = (guests, texts = []) => createGuestAgentContext({
  listGuests: async () => guests,
  instructions: { forDirectory: async (_directory, ids) => texts.filter(({ guestId }) => ids.has(guestId)) },
});

describe('what extensions add to agents', () => {
  test('signatures read like the catalog\'s', () => {
    expect(describeExtensionBlocks([row()])).toContain('Chart(title: string, values: string): A chart');
    expect(describeExtensionBlocks([row({ blocks: [] })])).toBe('');
  });

  test('a component that answers is named for asking, others are not', () => {
    expect(describeExtensionBlocks([row()])).not.toContain('To ask the user');
    const [block] = row().blocks;
    expect(describeExtensionBlocks([row({ blocks: [{ ...block, answers: true }] })])).toContain('To ask the user, when its description fits, use Chart in a reply block');
  });

  test('a paused extension adds nothing', async () => {
    const guests = [row({ enabled: false })];
    expect(await context(guests, [{ guestId: 'desk', text: 'x' }]).instructionText('/repo')).toBe('');
    expect(await context(guests).skillDirectories()).toEqual([]);
  });

  test('an approved extension is named with its text and its skills load from the package', async () => {
    const guests = [row()];
    const built = context(guests, [{ guestId: 'desk', text: 'read the wiki' }]);
    expect(await built.instructionText('/repo')).toContain('From the extension Desk:\nread the wiki');
    expect(await built.skillDirectories()).toEqual(['/pkg/skills']);
  });

  test('a catalog that cannot be read keeps what the session holds, and gives no skills', async () => {
    const failing = createGuestAgentContext({ listGuests: async () => { throw new Error('read'); }, instructions: { forDirectory: async () => [] } });
    expect(await failing.instructionText('/repo')).toBeNull();
    expect(await failing.skillDirectories()).toEqual([]);
  });
});
