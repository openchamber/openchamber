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
  opencodePlugin: 'plugin',
  capabilityGrants: ['service', 'instructions', 'skills', 'opencodePlugin'],
  blocks: [{ name: 'Chart', description: 'A chart', args: ['title', 'values'], entry: 'b.html' }],
  ...overrides,
});

// A package at /pkg whose plugin folder resolves; `/pkg/plugin` is a real directory with an entry.
const fakeFs = {
  realpath: async (target) => {
    if (target === '/pkg' || target.startsWith('/pkg/')) return target;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  stat: async (target) => ({ isDirectory: () => target === '/pkg/plugin', isFile: () => target === '/pkg/plugin/index.js' }),
  readFile: async (target) => {
    if (target === '/pkg/plugin/package.json') return JSON.stringify({ name: 'p', type: 'module', main: 'index.js' });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
};

const context = (guests, texts = []) => createGuestAgentContext({
  listGuests: async () => guests,
  instructions: { forDirectory: async (_directory, ids) => texts.filter(({ guestId }) => ids.has(guestId)) },
  fsPromises: fakeFs,
});

describe('what extensions add to agents', () => {
  test('leaves out the names the chat will not draw', () => {
    const block = { name: 'Card', args: [], description: 'mine', answers: true };
    expect(describeExtensionBlocks([row({ blocks: [block] })])).toBe('');
    const first = { name: 'Pick', args: ['a'], description: 'first' };
    const second = { name: 'Pick', args: ['b'], description: 'second' };
    const text = describeExtensionBlocks([row({ blocks: [first, second] })]);
    expect(text).toContain('first');
    expect(text).not.toContain('second');
  });

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
    expect(await context(guests).pluginDirectories()).toEqual([]);
  });

  test('the plugin folder is listed only for an active extension holding its grant, and only while it resolves', async () => {
    expect(await context([row()]).pluginDirectories()).toEqual(['/pkg/plugin']);
    // Needs approval: a requested grant is missing.
    expect(await context([row({ capabilityGrants: ['service', 'instructions', 'skills'] })]).pluginDirectories()).toEqual([]);
    // Enterprise mode stripped the grant from the row and marked it.
    expect(await context([row({ capabilityGrants: ['service', 'instructions', 'skills'], enterpriseBlocked: ['opencodePlugin'] })]).pluginDirectories()).toEqual([]);
    // No plugin declared.
    expect(await context([row({ opencodePlugin: undefined, capabilityGrants: ['service', 'instructions', 'skills'] })]).pluginDirectories()).toEqual([]);
    // The folder left the package root, or is gone: OpenCode is not told to load it.
    expect(await context([row({ opencodePlugin: '../elsewhere' })]).pluginDirectories()).toEqual([]);
    expect(await context([row({ packageRoot: '/gone' })]).pluginDirectories()).toEqual([]);
    // Removed: not in the catalog at all.
    expect(await context([]).pluginDirectories()).toEqual([]);
  });

  test('an approved extension is named with its text and its skills load from the package', async () => {
    const guests = [row()];
    const built = context(guests, [{ guestId: 'desk', text: 'read the wiki' }]);
    expect(await built.instructionText('/repo')).toContain('From the extension Desk:\nread the wiki');
    expect(await built.skillDirectories()).toEqual(['/pkg/skills']);
  });

  test('a catalog that cannot be read keeps what the session holds, and gives no skills or plugins', async () => {
    const failing = createGuestAgentContext({ listGuests: async () => { throw new Error('read'); }, instructions: { forDirectory: async () => [] } });
    expect(await failing.instructionText('/repo')).toBeNull();
    expect(await failing.skillDirectories()).toEqual([]);
    expect(await failing.pluginDirectories()).toEqual([]);
  });
});
