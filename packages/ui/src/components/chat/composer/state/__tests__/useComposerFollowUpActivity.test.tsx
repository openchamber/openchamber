import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { applyGlobalSessionStatusEvent, replaceGlobalSessionStatusById, setSessionParentResolver } from '@/sync/global-session-status';
import { useComposerFollowUpActivity } from '../useComposerFollowUpActivity';

type Props = {
  sessionId: string | null;
  phase: 'idle' | 'busy' | 'retry';
  autoReviewRunning: boolean;
  followUpBehavior: 'queue' | 'steer';
  hasPendingForm: boolean;
};

const initial: Props = {
  sessionId: 'parent', phase: 'idle', autoReviewRunning: false,
  followUpBehavior: 'queue', hasPendingForm: false,
};

function mount(initialProps: Props = initial) {
  const dom = installHookTestDom();
  const root = createRoot(dom.container);
  const result = { active: false };
  function Probe(props: Props) {
    result.active = useComposerFollowUpActivity(
      props.sessionId, props.phase, props.autoReviewRunning, props.followUpBehavior, props.hasPendingForm,
    );
    return null;
  }
  const render = (props: Props) => act(() => root.render(React.createElement(Probe, props)));
  render(initialProps);
  return { result, render, teardown: () => { act(() => root.unmount()); dom.restore(); } };
}

afterEach(() => {
  replaceGlobalSessionStatusById(new Map());
  setSessionParentResolver(() => undefined);
});

test('an idle parent waits for its live child and resumes after completion', () => {
  setSessionParentResolver((id) => id === 'child' ? 'parent' : undefined);
  const composer = mount();
  try {
    expect(composer.result.active).toBe(false);
    act(() => applyGlobalSessionStatusEvent('/repo', {
      type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } },
    }));
    expect(composer.result.active).toBe(true);
    act(() => applyGlobalSessionStatusEvent('/repo', {
      type: 'session.idle', properties: { sessionID: 'child' },
    }));
    expect(composer.result.active).toBe(false);
  } finally { composer.teardown(); }
});

test('nested subagents hold only their ancestors and a session switch releases the hold', () => {
  setSessionParentResolver((id) => id === 'nested' ? 'child' : id === 'child' ? 'parent' : undefined);
  replaceGlobalSessionStatusById(new Map([
    ['nested', { directory: '/repo', status: { type: 'busy' } }],
  ]));
  const composer = mount();
  try {
    expect(composer.result.active).toBe(true);
    composer.render({ ...initial, sessionId: 'unrelated' });
    expect(composer.result.active).toBe(false);
    composer.render({ ...initial, sessionId: null });
    expect(composer.result.active).toBe(false);
    composer.render(initial);
    expect(composer.result.active).toBe(true);
    act(() => replaceGlobalSessionStatusById(new Map()));
    expect(composer.result.active).toBe(false);
  } finally { composer.teardown(); }
});

test('steering and blocking forms retain the idle parent send behavior', () => {
  setSessionParentResolver((id) => id === 'child' ? 'parent' : undefined);
  replaceGlobalSessionStatusById(new Map([
    ['child', { directory: '/repo', status: { type: 'busy' } }],
  ]));
  const composer = mount();
  try {
    composer.render({ ...initial, followUpBehavior: 'steer' });
    expect(composer.result.active).toBe(false);
    composer.render({ ...initial, hasPendingForm: true });
    expect(composer.result.active).toBe(false);
    composer.render(initial);
    expect(composer.result.active).toBe(true);
  } finally { composer.teardown(); }
});

test('parent busy, retry and auto-review activity keep their existing behavior', () => {
  const composer = mount();
  try {
    for (const phase of ['busy', 'retry'] as const) {
      composer.render({ ...initial, phase, followUpBehavior: 'steer' });
      expect(composer.result.active).toBe(true);
    }
    composer.render({ ...initial, autoReviewRunning: true });
    expect(composer.result.active).toBe(true);
    composer.render(initial);
    expect(composer.result.active).toBe(false);
  } finally { composer.teardown(); }
});
