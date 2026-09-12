import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { RemoteSurfaceClient } from '@/lib/browser/remoteSurface';
import { mountInspectorView } from './RemoteBrowserInspector.test-support';
import { RemoteBrowserChrome } from './RemoteBrowserChrome';

test('moves focus across page tabs without attaching until the user activates one', async () => {
  const client = new RemoteSurfaceClient({ directory: '/project' });
  const tabs = ['one', 'two', 'three'].map((name) => ({ id: `sc:${name}`, title: name }));
  const { host } = await mountInspectorView(<RemoteBrowserChrome client={client}
    state={{ ...client.getState(), phase: 'attached', session: { id: 'session', directory: '/project' },
      tabs, activeTabId: 'sc:one' }} inspectionMode={null} onInspectionModeChange={() => undefined}
    inspectorButton={React.createRef()} viewportControlsOpen={false} onToggleViewportControls={() => undefined}
    pagePanelId="page-panel" />);
  const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
  expect(buttons.map((button) => button.getAttribute('aria-controls'))).toEqual(['page-panel', 'page-panel', 'page-panel']);
  buttons[0].focus();
  for (const [key, index] of [['ArrowRight', 1], ['ArrowRight', 2], ['ArrowRight', 0],
    ['ArrowLeft', 2], ['Home', 0], ['End', 2]] as const) {
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true,
    })));
    expect(document.activeElement).toBe(buttons[index]);
    expect(client.getState().activeTabId).toBeNull();
  }
  await act(async () => buttons[2].click());
  expect(client.getState().activeTabId).toBe('sc:three');
  client.stop();
});
