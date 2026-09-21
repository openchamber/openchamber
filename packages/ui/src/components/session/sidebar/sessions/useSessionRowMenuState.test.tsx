import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useSessionRowMenuState } from './useSessionRowMenuState';
import { installHookTestDom } from '../test-utils/testDom';

const MENU_KEY = 'session-menu:project:session:a';
const CONTEXT_KEY = 'session-context:project:session:a';

type Capture = {
  menu?: ReturnType<typeof useSessionRowMenuState>;
  openKey?: string | null;
};

const mountHook = async (contextMenuInstanceKey: string | null = CONTEXT_KEY) => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const capture: Capture = {};
  const pendingRename = { current: false };
  const completed: string[] = [];
  const Harness = () => {
    const [openKey, setOpenKey] = React.useState<string | null>(null);
    capture.openKey = openKey;
    capture.menu = useSessionRowMenuState({
      menuInstanceKey: MENU_KEY,
      contextMenuInstanceKey,
      openSidebarMenuKey: openKey,
      setOpenSidebarMenuKey: setOpenKey,
      hasDeferredCloseWork: () => pendingRename.current,
      onCloseComplete: () => {
        if (!pendingRename.current) return;
        pendingRename.current = false;
        completed.push('rename');
      },
    });
    return null;
  };
  await act(async () => root.render(React.createElement(Harness)));
  return {
    capture,
    pendingRename,
    completed,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

describe('session row menu state', () => {
  test('context menu closes after Rename and keeps the row pinned until close completes', async () => {
    const mounted = await mountHook();
    try {
      await act(async () => mounted.capture.menu!.handleContextMenuOpenChange(true));
      expect(mounted.capture.menu!.isContextMenuOpen).toBe(true);

      mounted.pendingRename.current = true;
      await act(async () => mounted.capture.menu!.handleContextMenuOpenChange(false));
      expect(mounted.capture.menu!.isContextMenuOpen).toBe(false);
      expect(mounted.capture.openKey).toBe(CONTEXT_KEY);

      await act(async () => mounted.capture.menu!.handleMenuOpenChangeComplete(false));
      expect(mounted.completed).toEqual(['rename']);
      expect(mounted.capture.openKey).toBeNull();
      expect(mounted.capture.menu!.isContextMenuOpen).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  test('overflow menu closes after Rename and can reopen', async () => {
    const mounted = await mountHook();
    try {
      await act(async () => mounted.capture.menu!.toggleMenu());
      expect(mounted.capture.menu!.isMenuOpen).toBe(true);

      mounted.pendingRename.current = true;
      await act(async () => mounted.capture.menu!.handleMenuOpenChange(false));
      expect(mounted.capture.menu!.isMenuOpen).toBe(false);
      expect(mounted.capture.openKey).toBe(MENU_KEY);

      await act(async () => mounted.capture.menu!.handleMenuOpenChangeComplete(false));
      expect(mounted.completed).toEqual(['rename']);
      expect(mounted.capture.openKey).toBeNull();

      await act(async () => mounted.capture.menu!.handleMenuOpenChange(true));
      expect(mounted.capture.menu!.isMenuOpen).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  test('plain close releases the shared key immediately', async () => {
    const mounted = await mountHook();
    try {
      await act(async () => mounted.capture.menu!.handleContextMenuOpenChange(true));
      await act(async () => mounted.capture.menu!.handleContextMenuOpenChange(false));
      expect(mounted.capture.openKey).toBeNull();
      expect(mounted.capture.menu!.isContextMenuOpen).toBe(false);
    } finally {
      await mounted.cleanup();
    }
  });

  test('rows without an occurrence key keep the context menu local', async () => {
    const mounted = await mountHook(null);
    try {
      await act(async () => mounted.capture.menu!.handleContextMenuOpenChange(true));
      expect(mounted.capture.menu!.isContextMenuOpen).toBe(true);
      expect(mounted.capture.openKey).toBeNull();
      await act(async () => mounted.capture.menu!.handleMenuOpenChange(true));
      expect(mounted.capture.menu!.isContextMenuOpen).toBe(false);
      expect(mounted.capture.menu!.isMenuOpen).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });
});
