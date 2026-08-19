import { describe, expect, test } from 'bun:test';

import { resolveAgentToolAction } from './actions.js';

/**
 * Both cases here are from one real conversation: the model called `read` and
 * then `get` on `openchamber_memory`, having dropped the namespace its own tool
 * name appeared to supply, and gave up after the second bare "unsupported".
 */
describe('a namespace the tool name already implies', () => {
  test('resolves a bare action inside the calling tool', () => {
    expect(resolveAgentToolAction('read', 'openchamber_memory')).toEqual({ action: 'memory.read' });
    expect(resolveAgentToolAction('save', 'openchamber_memory')).toEqual({ action: 'memory.save' });
  });

  test('resolves a bare name that is ambiguous only across tools', () => {
    // `delete` belongs to schedule and to memory; inside one tool it is plain.
    expect(resolveAgentToolAction('delete', 'openchamber_memory')).toEqual({ action: 'memory.delete' });
    expect(resolveAgentToolAction('delete', 'openchamber')).toEqual({ action: 'schedule.delete' });
  });

  test('keeps a fully qualified action as it is', () => {
    expect(resolveAgentToolAction('memory.read', 'openchamber_memory')).toEqual({ action: 'memory.read' });
  });

  test('does not reach outside the tool that asked', () => {
    // The memory tool asking for `open` must fail, not drive the browser.
    expect(resolveAgentToolAction('open', 'openchamber_memory').action).toBeUndefined();
  });
});

describe('an unidentified caller', () => {
  test('still resolves a bare name that means one thing everywhere', () => {
    expect(resolveAgentToolAction('snapshot', null)).toEqual({ action: 'browser.snapshot' });
  });

  test('refuses a bare name that several actions share', () => {
    expect(resolveAgentToolAction('list', null).action).toBeUndefined();
  });
});

describe('what an unresolvable action reports', () => {
  test('names the actions the calling tool actually has', () => {
    const { error } = resolveAgentToolAction('get', 'openchamber_memory');

    expect(error).toContain('memory.read');
    expect(error).toContain('memory.save');
    // Listing every action of every tool would bury the four that apply.
    expect(error).not.toContain('browser.open');
  });

  test('reports a missing action rather than resolving to something', () => {
    const { error, action } = resolveAgentToolAction('', 'openchamber_memory');

    expect(action).toBeUndefined();
    expect(error).toContain('missing');
  });

  test('an unknown tool falls back to the full action list', () => {
    const { error } = resolveAgentToolAction('nonsense', 'openchamber_future');

    expect(error).toContain('memory.read');
    expect(error).toContain('browser.open');
  });
});
