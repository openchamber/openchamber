/**
 * The closed right zone keeps the work status card's column. The card widens
 * with the interface size, so the column must too: a column fixed at 300px
 * plus 24px held a 450px card at 150%, which then hung over the chat.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DIRECTORY, installDom, renderContextPanels } from './contextPanelHarness';

// The drawer mounts every tab's body, hidden or not. Their own tests cover them, so they stand in here.
mock.module('@/apps/MobileChangesSurface', () => ({ MobileChangesSurface: () => null }));
mock.module('@/apps/MobileFilesSurface', () => ({ MobileFilesSurface: () => null }));
mock.module('@/components/layout/RightSidebarTabs', () => ({ ProjectContextPanel: () => null }));

const dom = installDom();
const { useUIStore } = await import('@/stores/useUIStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { setWorkStatusReserved } = await import('../rightSlot');
const { getWorkStatusWidths } = await import('@/components/chat/work-status/useWorkStatusVisibility');

afterAll(async () => {
  await dom.restore();
});

describe('the right slot holds the work status column', () => {
  let root: Root;
  const previousSize = useUIStore.getState().fontSize;

  afterEach(async () => {
    await act(async () => root.unmount());
    await act(async () => {
      setWorkStatusReserved(false);
      useUIStore.setState({ fontSize: previousSize });
    });
  });

  test('as wide as the card and its margins at every interface size', async () => {
    useUIStore.setState({ contextPanelByDirectory: {}, fontSize: 100 });
    useDirectoryStore.setState({ currentDirectory: DIRECTORY });
    setWorkStatusReserved(true);
    root = createRoot(dom.container);
    await renderContextPanels(root);

    const slot = () => document.querySelector<HTMLElement>('aside[data-right-slot]');
    // Positive control: the closed slot is there and reserves the 100% column.
    expect(slot()?.dataset.contextPanelOpen).toBe('false');
    expect(slot()?.style.width).toBe('324px');

    await act(async () => useUIStore.setState({ fontSize: 150 }));
    expect(slot()?.style.width).toBe(`${getWorkStatusWidths(150).column}px`);
    expect(getWorkStatusWidths(150).column).toBe(486);
  });
});
