import { describe, expect, it } from 'vitest';

import { appendManagedPermissions } from './managed-plugin-config.js';

const deny = { action: 'openchamber_workflow_answer', resource: '*', effect: 'deny' };

describe('appendManagedPermissions', () => {
  it("keeps the user's rules first and adds ours once", () => {
    const user = { action: 'bash', resource: '*', effect: 'ask' };
    const once = appendManagedPermissions(JSON.stringify({ permissions: [user], model: 'x' }), [deny]);
    const twice = appendManagedPermissions(once, [deny]);
    expect(JSON.parse(twice)).toEqual({ permissions: [user, deny], model: 'x' });
  });

  it('starts a list in an empty config and refuses one that is not a list', () => {
    expect(JSON.parse(appendManagedPermissions(undefined, [deny]))).toEqual({ permissions: [deny] });
    expect(() => appendManagedPermissions('{"permissions":{}}', [deny])).toThrow('must be an array');
  });
});
