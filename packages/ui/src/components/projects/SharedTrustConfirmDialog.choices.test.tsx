import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import type { ProjectSetup, ProjectSetupPatch } from '@/lib/openchamberConfig';

const project: ProjectRef = { id: 'fixture', path: '/repo' };
let patches: ProjectSetupPatch[] = [];

const setup: ProjectSetup = {
  trust: { hash: 'sha256:fixture', trusted: false },
  setupWorktree: ['bun install', 'cp .env.example .env'],
  setupWorktreeWait: false,
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'ok',
    path: '.openchamber/project.json',
    setupWorktree: ['bun install'],
    setupWorktreeWait: null,
    projectActions: [],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: ['cp .env.example .env'],
    setupWorktreeWait: null,
    setupWorktreeMode: 'append',
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: [],
    sharedTrust: null,
  },
};

mock.module('@/lib/openchamberConfig', () => ({
  getProjectSetup: async () => setup,
  updateProjectSetup: async (_project: ProjectRef, patch: ProjectSetupPatch) => {
    patches.push(patch);
    return true;
  },
}));

const {
  getSharedTrustConfirmationSnapshot,
  resolveWorktreeSetupCommandsOrCancel,
  settleSharedTrustConfirmation,
} = await import('@/lib/sharedTrustConfirmation');
const loadDialog = async () => (await import('./SharedTrustConfirmDialog')).SharedTrustConfirmDialog;

let testWindow: Window;
let root: Root;
let host: HTMLDivElement;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;

const findButton = (label: string): HTMLButtonElement | undefined => (
  Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent === label)
);

beforeEach(() => {
  patches = [];
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
  if (getSharedTrustConfirmationSnapshot()) settleSharedTrustConfirmation('cancel');
  testWindow.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const renderPendingWorktreePrompt = async (): Promise<{ pending: Promise<string[] | null> }> => {
  const SharedTrustConfirmDialog = await loadDialog();
  const pending = resolveWorktreeSetupCommandsOrCancel(project);
  // The request is raised after the setup snapshot is read.
  await act(async () => { await Promise.resolve(); });
  await act(async () => root.render(<I18nProvider><SharedTrustConfirmDialog /></I18nProvider>));
  expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
  return { pending };
};

test('closing the prompt cancels the worktree request instead of creating one', async () => {
  const { pending } = await renderPendingWorktreePrompt();

  const close = document.querySelector<HTMLElement>('[data-slot="dialog-close"]');
  expect(close).not.toBeNull();
  await act(async () => close?.click());

  expect(await pending).toBeNull();
  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(patches).toEqual([]);
});

test('"Not this time" skips the shared commands and keeps the worktree request', async () => {
  const { pending } = await renderPendingWorktreePrompt();

  const skip = findButton('Not this time');
  expect(skip).toBeDefined();
  await act(async () => skip?.click());

  expect(await pending).toEqual(['cp .env.example .env']);
  expect(patches).toEqual([]);
});

test('"Trust and run" records the trust answer and keeps the worktree request', async () => {
  const { pending } = await renderPendingWorktreePrompt();

  const trust = findButton('Trust and run');
  expect(trust).toBeDefined();
  await act(async () => trust?.click());

  expect(await pending).toEqual(['bun install', 'cp .env.example .env']);
  expect(patches).toEqual([{ sharedTrustHash: 'sha256:fixture' }]);
});
