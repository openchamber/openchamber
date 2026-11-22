import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';
import {
  createPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { CreateMultiRunParams } from '@/types/multirun';
import { useParallelComposer, type ParallelComposer } from './useParallelComposer';

type Props = { autoIsolate: boolean };
type Capture = { composer: ParallelComposer | null };

/**
 * Drives the hook against the real stores; only the store's `createMultiRun`
 * is replaced, so the oracle is the launch request the composer builds.
 */
async function withComposer(run: (input: {
  capture: Capture;
  render: (props: Props) => Promise<void>;
  launches: CreateMultiRunParams[];
}) => Promise<void>) {
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
  let message = 'Fix the login';
  const Harness = ({ autoIsolate }: Props) => {
    capture.composer = useParallelComposer({
      enabled: true,
      draftOpen: true,
      draftProjectId: 'p1',
      autoIsolate,
      message,
      setMessage: (text) => { message = text; },
    });
    return null;
  };
  const render = (props: Props) => act(async () => root.render(
    React.createElement(I18nProvider, null, React.createElement(Harness, props)),
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
  test('auto-create worktree on: separate worktrees by default', async () => {
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo' });
    await withComposer(async ({ capture, render, launches }) => {
      await render({ autoIsolate: true });
      await enterWithTwoModels(capture);
      expect(capture.composer?.state?.isolate).toBe(true);
      await act(async () => { await capture.composer?.launch(); });
      expect(launches).toHaveLength(1);
      expect(launches[0].isolateRuns).toBe(true);
      expect(launches[0].sharedDirectory).toBeUndefined();
      expect(launches[0].groups[0].models).toHaveLength(2);
    });
  });

  test('auto-create worktree off: the runs share the draft directory and no worktree is asked for', async () => {
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo-worktrees/picked', preserveDirectoryOverride: true });
    await withComposer(async ({ capture, render, launches }) => {
      await render({ autoIsolate: false });
      await enterWithTwoModels(capture);
      expect(capture.composer?.state?.isolate).toBe(false);
      await act(async () => { await capture.composer?.launch(); });
      expect(launches[0].isolateRuns).toBe(false);
      expect(launches[0].sharedDirectory).toBe('/repo-worktrees/picked');
      expect(launches[0].setupCommands).toBeUndefined();
      expect(launches[0].worktreeBaseBranch).toBeUndefined();
    });
  });

  test('follows the switch until the user chooses, then keeps the choice', async () => {
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo' });
    await withComposer(async ({ capture, render }) => {
      await render({ autoIsolate: false });
      await enterWithTwoModels(capture);
      await render({ autoIsolate: true });
      expect(capture.composer?.state?.isolate).toBe(true);
      await act(async () => capture.composer?.setIsolate(false));
      await render({ autoIsolate: false });
      await render({ autoIsolate: true });
      expect(capture.composer?.state?.isolate).toBe(false);
      expect(capture.composer?.state?.isolateChosen).toBe(true);
    });
  });

  test('a shared run waits for the worktree the draft is still making', async () => {
    const requestId = createPendingDraftWorktreeRequest();
    openDraft({ target: 'project', selectedProjectId: 'p1', directoryOverride: '/repo', pendingWorktreeRequestId: requestId });
    await withComposer(async ({ capture, render, launches }) => {
      await render({ autoIsolate: false });
      await enterWithTwoModels(capture);
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
      await render({ autoIsolate: true });
      await enterWithTwoModels(capture);
      const launch = capture.composer?.launch;
      await act(async () => { await Promise.all([launch?.(), launch?.()]); });
      expect(launches).toHaveLength(1);
    });
  });
});
