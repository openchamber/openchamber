import { afterEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { openGuestSurface } from './open-surface';

describe('openGuestSurface', () => {
  afterEach(() => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: false, contextPanelByDirectory: {} });
  });

  test('cannot open Workflows in a build without workflows, so an extension never learns it exists', () => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: false });
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({
      ok: false,
      code: 'UNSUPPORTED',
      message: 'That surface cannot open here.',
    });
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
  });

  test('opens Workflows where the build has them', () => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: true });
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({ ok: true });
  });
});
