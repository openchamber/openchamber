import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';
import {
  createPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { CreateMultiRunParams } from '@/types/multirun';
import { useParallelComposer, type ParallelComposer } from './useParallelComposer';

type Capture = { composer: ParallelComposer | null };

/**
 * Drives the hook against the real stores; only the store's `createMultiRun`
 * is replaced, so the oracle is the launch request the composer builds.
 */
async function withComposer(run: (input: {
  capture: Capture;
  render: () => Promise<void>;
  launches: CreateMultiRunParams[];
}) => Promise<void>, initialMessage = 'Fix the login') {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const capture: Capture = { composer: null };
  const launches: CreateMultiRunParams[] = [];
  const original = useMultiRunStore.getState().createMultiRun;
  const projects = useProjectsStore.getState();
  useProjectsStore.setState({ projects: [{ ...projects.projects[0], id: 'p1', path: '/repo' }], activeProjectId: 'p1' });
  useMultiRunStore.setState({
    createMultiRun: async (params) => {
      launches.push(params);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { groupSlug: 'g', groupKey: 'id:g', sessionIds: ['a', 'b'], firstSessionId: 'a', failedCount: 0 };
    },
  });
  let message = initialMessage;
  const Harness = () => {
    capture.composer = useParallelComposer({
      enabled: true,
      draftOpen: true,
      draftProjectId: 'p1',
      message,
      setMessage: (text) => { message = text; },
    });
    return null;
  };
  const render = () => act(async () => root.render(
    React.createElement(I18nProvider, null, React.createElement(Harness)),
  ));
  try {
    await run({ capture, render, launches });
  } finally {
    await act(async () => root.unmount());
    useMultiRunStore.setState({ createMultiRun: original });
    useProjectsStore.setState({ projects: projects.projects, activeProjectId: projects.activeProjectId });
    useSessionUIStore.getState().closeNewSessionDraft();
    dom.restore();
  }
}

const enterWithTwoModels = async (capture: Capture) => {
  await act(async () => capture.composer?.enter());
  await act(async () => {
    capture.composer?.addModel({ providerID: 'openai', modelID: 'gpt-5' });
    capture.composer?.addModel({ providerID: 'anthropic', modelID: 'claude' });
  });
};

const openDraft = (options: Parameters<ReturnType<typeof useSessionUIStore.getState>['openNewSessionDraft']>[0]) => {
  useSessionUIStore.getState().openNewSessionDraft(options);
};

describe('useParallelComposer worktree policy', () => {
  test('separate worktrees by default, from where Settings say parallel runs start', async () => {
    useConfigStore.setState({ settingsWorktreeStartFrom: 'project-root', settingsWorktreeStartFromOverrides: { parallel: 'remote-default' } });
    // Aimed at an existing worktree, the run still gets new worktrees.
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo-worktrees/picked', preserveDirectoryOverride: true });
    await withComposer(async ({ capture, render, launches }) => {
      await render();
      await enterWithTwoModels(capture);
      expect(capture.composer?.state?.isolate).toBe(true);
      await act(async () => { await capture.composer?.launch(); });
      expect(launches).toHaveLength(1);
      expect(launches[0].isolateRuns).toBe(true);
      expect(launches[0].worktreeStartFrom).toBe('remote-default');
      expect(launches[0].worktreeBaseBranch).toBeUndefined();
      expect(launches[0].sharedDirectory).toBeUndefined();
      expect(launches[0].groups[0].models).toHaveLength(2);
    });
  });

  test('a picked base branch wins over the Settings start', async () => {
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo' });
    await withComposer(async ({ capture, render, launches }) => {
      await render();
      await enterWithTwoModels(capture);
      await act(async () => capture.composer?.setBaseBranch('feature/x'));
      await act(async () => { await capture.composer?.launch(); });
      expect(launches[0].worktreeBaseBranch).toBe('feature/x');
    });
  });

  test('shared directory: the runs share the draft directory and no worktree is asked for', async () => {
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo-worktrees/picked', preserveDirectoryOverride: true });
    await withComposer(async ({ capture, render, launches }) => {
      await render();
      await enterWithTwoModels(capture);
      await act(async () => capture.composer?.setIsolate(false));
      await act(async () => { await capture.composer?.launch(); });
      expect(launches[0].isolateRuns).toBe(false);
      expect(launches[0].sharedDirectory).toBe('/repo-worktrees/picked');
      expect(launches[0].setupCommands).toBeUndefined();
      expect(launches[0].worktreeBaseBranch).toBeUndefined();
      expect(launches[0].worktreeStartFrom).toBeUndefined();
    });
  });

  test('a shared run waits for the worktree the draft is still making', async () => {
    const requestId = createPendingDraftWorktreeRequest();
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo', pendingWorktreeRequestId: requestId });
    await withComposer(async ({ capture, render, launches }) => {
      await render();
      await enterWithTwoModels(capture);
      await act(async () => capture.composer?.setIsolate(false));
      let launched: Promise<void> | undefined;
      await act(async () => { launched = capture.composer?.launch(); });
      expect(launches).toHaveLength(0);
      resolvePendingDraftWorktreeRequest(requestId, '/repo-worktrees/quick', { keep: true });
      await act(async () => { await launched; });
      expect(launches.map((params) => params.sharedDirectory)).toEqual(['/repo-worktrees/quick']);
    });
  });

  test('pressing launch twice before it settles starts one run', async () => {
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo' });
    await withComposer(async ({ capture, render, launches }) => {
      await render();
      await enterWithTwoModels(capture);
      const launch = capture.composer?.launch;
      await act(async () => { await Promise.all([launch?.(), launch?.()]); });
      expect(launches).toHaveLength(1);
    });
  });
});

describe('generated prompt variants', () => {
  // Oracle: selected candidates become ordinary variants and preserve the
  // original text. Each added variant owns its run-model array independently.
  test('retains the original and admits exactly the chosen prompts with independent run models', async () => {
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm', providers: [] });
    await withComposer(async ({ capture, render }) => {
      await render();
      await act(async () => capture.composer?.enter());
      await act(async () => capture.composer?.addGeneratedVariants(['Selected B', 'Selected C']));
      expect(capture.composer?.state?.variants.map((variant) => variant.text)).toEqual(['Fix the login', 'Selected B', 'Selected C']);
      expect(capture.composer?.state?.active).toBe(1);
      expect(capture.composer?.getActivePrompt()).toBe('Selected B');
      expect(capture.composer?.state?.isolate).toBe(true);
      await act(async () => capture.composer?.incrementModel(0));
      expect(capture.composer?.state?.variants.map((variant) => variant.models[0]?.count)).toEqual([1, 2, 1]);
    });
  });

  test('new prompts replace only the empty placeholder and empty selection changes nothing', async () => {
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm', providers: [] });
    await withComposer(async ({ capture, render }) => {
      await render();
      await act(async () => capture.composer?.enter());
      const before = capture.composer?.state;
      await act(async () => capture.composer?.addGeneratedVariants(['', ' ']));
      expect(capture.composer?.state).toBe(before);
      await act(async () => capture.composer?.addGeneratedVariants(['Selected A', 'Selected B']));
      expect(capture.composer?.state?.variants.map((variant) => variant.text)).toEqual(['Selected A', 'Selected B']);
      expect(capture.composer?.state?.active).toBe(0);
    }, '');
  });
});
