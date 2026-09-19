import { describe, expect, it, vi } from 'vitest';

import { withFeatureRouteBroadcastDependency } from './index.js';

describe('withFeatureRouteBroadcastDependency', () => {
  it('adds the global UI event broadcaster to feature route dependencies', () => {
    const routeDependencies = {
      resolveProjectDirectory: vi.fn(),
      readSettingsFromDisk: vi.fn(),
    };
    const broadcastGlobalUiEvent = vi.fn();

    expect(withFeatureRouteBroadcastDependency(routeDependencies, broadcastGlobalUiEvent)).toEqual({
      ...routeDependencies,
      broadcastGlobalUiEvent,
    });
  });
});
