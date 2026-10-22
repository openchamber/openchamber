import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { ProjectEntry } from '@/lib/api/types';
// Loaded before a window exists, so the directory store does not look for a server.
import { ProjectRailPage } from './ProjectRailPage';

const projects: ProjectEntry[] = [
  { id: 'rocket', path: '/repos/rocket', label: 'Rocket', icon: 'rocket', color: '#ff0000' },
  { id: 'plain', path: '/repos/plain' },
];

describe('ProjectRailPage', () => {
  let win: Window;
  let root: Root | undefined;
  const previous = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    win = new Window({ url: 'http://localhost/' });
    const values = {
      window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
      requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  });

  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = undefined;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    previous.clear();
    await win.happyDOM.close();
  });

  const render = async (props: { projects: readonly ProjectEntry[]; leadingScope?: { id: string; label: React.ReactNode }; onSelect?: (id: string) => void }) => {
    const container = document.createElement('div');
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => mounted.render(
      <ThemeSystemProvider>
        <ProjectRailPage
          label="Projects"
          projects={props.projects}
          selectedId="rocket"
          onSelect={props.onSelect ?? (() => undefined)}
          leadingScope={props.leadingScope}
          trailing={(project) => (project.id === 'rocket' ? <span>3</span> : null)}
          emptyText="No projects"
        >
          <p>Content</p>
        </ProjectRailPage>
      </ThemeSystemProvider>,
    ));
    return [...container.querySelectorAll<HTMLButtonElement>('nav button')];
  };

  test('lists the scope first, then the projects in the given order, each with its own icon', async () => {
    // Given projects in the sidebar's order, one with a chosen icon and colour and one without.
    const rows = await render({ projects, leadingScope: { id: 'chats', label: 'Chats' } });

    // Then the scope leads, each project row draws its icon, and the count sits on its own row.
    expect(rows.map((row) => row.textContent)).toEqual(['Chats', 'Rocket3', 'plain']);
    const rocketIcon = rows[1]?.querySelector('svg');
    expect(rocketIcon?.querySelector('use')?.getAttribute('href')).toBe('#oc-rocket');
    expect(rocketIcon?.getAttribute('style')).toContain('#ff0000');
    expect(rows[2]?.querySelector('svg use')?.getAttribute('href')).toBe('#oc-folder');
  });

  test('marks the selected project and reports the row picked', async () => {
    // Given the rail with Rocket selected.
    const picked: string[] = [];
    const rows = await render({ projects, onSelect: (id) => picked.push(id) });

    // When another project is clicked.
    await act(async () => rows[1]?.click());

    // Then only the selected row is current, and the click names the project.
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(['page', null]);
    expect(picked).toEqual(['plain']);
  });

  test('says there is nothing to list without projects or a scope', async () => {
    // Given no projects and no leading scope.
    const rows = await render({ projects: [] });

    // Then the list holds only the empty text, and the content still renders.
    expect(rows).toHaveLength(0);
    expect(document.querySelector('nav')?.textContent).toBe('No projects');
    expect(document.body.textContent).toContain('Content');
  });
});
