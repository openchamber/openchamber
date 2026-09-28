import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { I18nProvider } from '@/lib/i18n';
import type { ProjectSetup } from '@/lib/openchamberConfig';
import {
  ensureSharedSetupTrusted,
  getSharedTrustConfirmationSnapshot,
  settleSharedTrustConfirmation,
} from '@/lib/sharedTrustConfirmation';

const setup: ProjectSetup = {
  trust: { hash: 'sha256:fixture', trusted: false },
  setupWorktree: ['true'],
  setupWorktreeWait: false,
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'ok',
    path: '.openchamber/project.json',
    setupWorktree: ['true'],
    setupWorktreeWait: null,
    projectActions: [],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: [],
    setupWorktreeWait: null,
    setupWorktreeMode: 'append',
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: [],
    sharedTrust: null,
  },
};

let testWindow: Window;
let root: Root;
let host: HTMLDivElement;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  testWindow = new Window({ url: 'http://localhost' });
  previousGlobals = new Map(
    ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']
      .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, {
    window: testWindow,
    document: testWindow.document,
    navigator: testWindow.navigator,
    HTMLElement: testWindow.HTMLElement,
    Element: testWindow.Element,
    Node: testWindow.Node,
    requestAnimationFrame: testWindow.requestAnimationFrame.bind(testWindow),
    cancelAnimationFrame: testWindow.cancelAnimationFrame.bind(testWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  if (getSharedTrustConfirmationSnapshot()) settleSharedTrustConfirmation('skip');
  testWindow.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('shared command confirmation layers above an open mobile worktree sheet', async () => {
  const { SharedTrustConfirmDialog } = await import('./SharedTrustConfirmDialog');
  const pending = ensureSharedSetupTrusted({ id: 'fixture', path: '/repo' }, setup);

  await act(async () => root.render(
    <I18nProvider>
      <MobileOverlayPanel open title="New Worktree" onClose={() => undefined}>Worktree form</MobileOverlayPanel>
      <SharedTrustConfirmDialog />
    </I18nProvider>,
  ));

  const sheet = document.querySelector<HTMLElement>('#mobile-overlay-root > [role="dialog"]');
  const confirmation = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');

  expect(sheet?.classList).toContain('z-[60]');
  expect(confirmation?.textContent).toContain('true');
  expect(confirmation?.parentElement?.classList).toContain('z-[70]');
  expect(backdrop?.classList).toContain('z-[70]');

  await act(async () => {
    settleSharedTrustConfirmation('skip');
    await pending;
  });
});
