import React, { act } from 'react';
import { Window } from 'happy-dom';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsProjectSelector } from './SettingsProjectSelector';

test('mobile picker reaches every project and changes only the Settings directory', async () => {
  const win = new Window({ url: 'http://localhost' });
  const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const projects = Array.from({ length: 55 }, (_, index) => ({ id: `project-${index}`, path: `/projects/${index}`, label: `Project ${String(index).padStart(2, '0')}` }));
  const initialProjects = useProjectsStore.getState();
  const initialUI = useUIStore.getState();
  useProjectsStore.setState({ projects: [...projects].reverse(), activeProjectId: projects[0].id });
  useUIStore.setState({ isMobile: true, settingsProjectPath: null });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ThemeSystemProvider><I18nProvider><SettingsProjectSelector /></I18nProvider></ThemeSystemProvider>));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Switch project"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    const dialog = document.querySelector('[role="dialog"]');
    const rows = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).filter((row) => row.textContent?.startsWith('Project '));
    expect(rows).toHaveLength(55);
    expect(rows[0].textContent).toBe('Project 00');
    expect(rows[54].textContent).toBe('Project 54');
    await act(async () => rows[54].click());
    expect(useUIStore.getState().settingsProjectPath).toBe('/projects/54');
    expect(useProjectsStore.getState().activeProjectId).toBe('project-0');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger?.textContent).toBe('Project 54');
    await act(async () => useProjectsStore.setState({ projects: [] }));
    expect(container.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    useProjectsStore.setState(initialProjects);
    useUIStore.setState(initialUI);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await win.happyDOM.close();
  }
});
