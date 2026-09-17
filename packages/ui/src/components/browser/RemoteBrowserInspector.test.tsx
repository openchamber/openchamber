import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { inspectorFixture, mountInspectorView } from './RemoteBrowserInspector.test-support';
import { BrowserToolbar } from './BrowserToolbar';
import { RemoteBrowserInspector } from './RemoteBrowserInspector';

const toolbarProps = {
  address: 'https://example.test', onAddressChange: () => undefined, onSubmit: () => undefined,
  onBack: () => undefined, onForward: () => undefined, onReload: () => undefined,
  canGoBack: false, canGoForward: false, isLoading: false,
};

function InspectorModeHarness({ inspector }: { readonly inspector: ReturnType<typeof inspectorFixture>['inspector'] }) {
  const [mode, setMode] = React.useState<'simple' | null>(null);
  const returnFocus = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { inspector.setOpen(mode === 'simple'); }, [inspector, mode]);
  return <>
    <BrowserToolbar {...toolbarProps} devToolsButtonRef={returnFocus} devToolsLabel="Open page inspector"
      devToolsPressed={mode === 'simple'} onOpenDevTools={() => setMode((current) => current === 'simple' ? null : 'simple')} />
    <RemoteBrowserInspector inspector={inspector} returnFocus={returnFocus} />
  </>;
}

describe('remote browser inspector controls', () => {
  test('labels the existing developer-tools action for the remote page inspector', async () => {
    const { host } = await mountInspectorView(<BrowserToolbar address="https://example.test" onAddressChange={() => undefined}
      onSubmit={() => undefined} onBack={() => undefined} onForward={() => undefined} onReload={() => undefined}
      canGoBack={false} canGoForward={false} isLoading={false} onOpenDevTools={() => undefined}
      devToolsLabel="Open page inspector" />);
    expect(host.querySelector('button[aria-label="Open page inspector"]')).not.toBeNull();
  });

  test('captures only after opening and restores toolbar focus when closed', async () => {
    const fixture = inspectorFixture();
    const { host } = await mountInspectorView(<InspectorModeHarness inspector={fixture.inspector} />);
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(fixture.commands).toEqual([]);
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open page inspector"]');
    if (!open) throw new Error('Expected inspector action');
    await act(async () => open.click());
    expect(fixture.commands.filter((command) => command.type === 'inspectorStart').length).toBe(1);
    expect(host.querySelector('[role="region"]')).not.toBeNull();
    await fixture.start();
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close inspector"]');
    if (!close) throw new Error('Expected close action');
    await act(async () => close.click());
    expect(fixture.commands.at(-1)?.type).toBe('inspectorStop');
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  test('filters plaintext events and keeps inspector batches out of the toolbar render', async () => {
    const fixture = inspectorFixture();
    await fixture.start();
    let toolbarRenders = 0;
    const { host } = await mountInspectorView(<>
      <React.Profiler id="toolbar" onRender={() => { toolbarRenders += 1; }}>
        <BrowserToolbar {...toolbarProps} devToolsLabel="Open page inspector" onOpenDevTools={() => undefined} />
      </React.Profiler>
      <RemoteBrowserInspector inspector={fixture.inspector} />
    </>);
    const initialRenders = toolbarRenders;
    await act(async () => fixture.inspector.receive(JSON.stringify({ type: 'inspectorEvents', tabId: 'sc:inspected', captureId: 'capture-1',
      console: [
        { id: 'log-1', timestamp: 1, level: 'log', text: '<script>page-controlled()</script>', source: '', line: null, truncated: false },
        { id: 'log-2', timestamp: 2, level: 'warning', text: 'keep this message', source: '', line: null, truncated: true },
      ], network: [], droppedConsole: 7, droppedNetwork: 0 })));
    expect(toolbarRenders).toBe(initialRenders);
    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toContain('<script>page-controlled()</script>');
    expect(host.textContent).toContain('Entries omitted: 7');
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error('Expected filter');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'keep');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'keep' }));
    });
    expect(host.textContent).toContain('keep this message');
    expect(host.textContent).not.toContain('page-controlled()');
  });

  test('supports keyboard tab switching and clears only the selected scope', async () => {
    const fixture = inspectorFixture();
    await fixture.start();
    const { host } = await mountInspectorView(<RemoteBrowserInspector inspector={fixture.inspector} />);
    const consoleTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    if (!consoleTab) throw new Error('Expected Console tab');
    await act(async () => consoleTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(document.activeElement?.textContent).toBe('Network');
    const clear = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Clear');
    if (!clear) throw new Error('Expected clear action');
    await act(async () => clear.click());
    const command = fixture.commands.at(-1);
    if (command?.type !== 'inspectorClear') throw new Error('Expected clear command');
    expect(command.scope).toBe('network');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Network');
  });
});
