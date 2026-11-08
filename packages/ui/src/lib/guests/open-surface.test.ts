import { afterEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { openGuestSurface } from './open-surface';

describe('openGuestSurface', () => {
  afterEach(() => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: false, agentWorkflowToolEnabled: false, contextPanelByDirectory: {} });
  });

  for (const [label, flags] of [
    ['without workflows (VS Code)', { agentWorkflowFeatureAvailable: false, agentWorkflowToolEnabled: true }],
    ['with the workflow tool turned off', { agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: false }],
  ] as const) test(`cannot open Workflows ${label}, so an extension never learns it exists`, () => {
    useUIStore.setState(flags);
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({
      ok: false,
      code: 'UNSUPPORTED',
      message: 'That surface cannot open here.',
    });
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBeUndefined();
  });

  test('opens Workflows once the workflow tool is on', () => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({ ok: true });
  });

  test('closes an open Workflows tab when the workflow tool is turned off', () => {
    useUIStore.setState({ agentWorkflowFeatureAvailable: true, agentWorkflowToolEnabled: true });
    expect(openGuestSurface({ mode: 'workflows', directory: '/repo', supported: true })).toEqual({ ok: true });
    useUIStore.getState().setAgentWorkflowToolEnabled(false);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs.some((tab) => tab.mode === 'workflows')).toBe(false);
  });
});
