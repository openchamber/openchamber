import { describe, expect, it } from 'vitest';
import { changeRequestNetworkTarget } from './repository-network.js';

describe('changeRequestNetworkTarget', () => {
  const network = [{ id: 1, name: 'alice/app' }, { id: 3, name: 'carol/app' }];
  const byId = (member, id) => member.id === id;

  it('answers the member a change request targets, whatever its source', () => {
    expect(changeRequestNetworkTarget(network, 3, byId)).toBe(network[1]);
  });

  it('answers null for a target outside the network or no network at all', () => {
    expect(changeRequestNetworkTarget(network, 2, byId)).toBeNull();
    expect(changeRequestNetworkTarget(null, 1, byId)).toBeNull();
  });
});
