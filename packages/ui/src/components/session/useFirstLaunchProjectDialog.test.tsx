import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { installHookTestDom } from './sidebar/test-utils/testDom';
import { useFirstLaunchProjectDialog } from './useFirstLaunchProjectDialog';

type Settings = { addProjectDialogDismissed?: boolean } | null;

const render = async (settings: Settings, props: { ready?: boolean; hasProjects?: boolean } = {}) => {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const captured = React.createRef<ReturnType<typeof useFirstLaunchProjectDialog>>();
  let reads = 0;
  let saves = 0;
  const loadSettings = async () => {
    reads += 1;
    return settings;
  };
  const saveDismissed = () => {
    saves += 1;
  };
  const Harness = ({ ready = true, hasProjects = false }: { ready?: boolean; hasProjects?: boolean }) => {
    captured.current = useFirstLaunchProjectDialog({ ready, hasProjects, loadSettings, saveDismissed });
    return null;
  };
  await act(async () => root.render(<Harness {...props} />));
  return {
    captured,
    rerender: (next: { ready?: boolean; hasProjects?: boolean }) => act(async () => root.render(<Harness {...next} />)),
    reads: () => reads,
    saves: () => saves,
    cleanup: () => {
      act(() => root.unmount());
      dom.restore();
    },
  };
};

test('opens by itself on the first launch, and closing it is remembered', async () => {
  const view = await render({});
  try {
    expect(view.captured.current?.open).toBe(true);
    await act(async () => view.captured.current?.onOpenChange(false));
    expect(view.captured.current?.open).toBe(false);
    expect(view.saves()).toBe(1);
  } finally {
    view.cleanup();
  }
});

test('stays closed once the user has closed it on an earlier launch', async () => {
  const view = await render({ addProjectDialogDismissed: true });
  try {
    expect(view.captured.current?.open).toBe(false);
    // Removing the last project later does not open it either.
    await view.rerender({ hasProjects: true });
    await view.rerender({ hasProjects: false });
    expect(view.captured.current?.open).toBe(false);
    expect(view.reads()).toBe(1);
  } finally {
    view.cleanup();
  }
});

test('an unreadable settings document opens nothing', async () => {
  const view = await render(null);
  try {
    expect(view.captured.current?.open).toBe(false);
  } finally {
    view.cleanup();
  }
});

test('waits for the app to be ready and for there to be no project', async () => {
  const view = await render({}, { ready: false });
  try {
    expect(view.reads()).toBe(0);
    await view.rerender({ ready: true, hasProjects: true });
    expect(view.reads()).toBe(0);
    await view.rerender({ ready: true, hasProjects: false });
    expect(view.captured.current?.open).toBe(true);
  } finally {
    view.cleanup();
  }
});

test('the add-project button still opens it after it was closed', async () => {
  const view = await render({ addProjectDialogDismissed: true });
  try {
    await act(async () => view.captured.current?.setOpen(true));
    expect(view.captured.current?.open).toBe(true);
  } finally {
    view.cleanup();
  }
});
