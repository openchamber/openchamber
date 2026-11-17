import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test } from 'bun:test';
import { applyGoalChoice, rearmQueuedGoal, useSessionGoalArmStore } from './useSessionGoalArmStore';

describe('rearmQueuedGoal', () => {
  beforeEach(() => useSessionGoalArmStore.getState().setArmed(false));

  test('arms the composer with the queued goal and its flags', () => {
    rearmQueuedGoal({ objective: 'Approved spec', settled: true, briefAgent: true, ignoreLimit: true });
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: 'Approved spec', settled: true, briefAgent: true, ignoreLimit: true,
    });
  });

  test('a goal queued without flags or objective comes back plain', () => {
    rearmQueuedGoal({});
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: null, settled: false, briefAgent: false, ignoreLimit: false,
    });
  });
});

describe('applyGoalChoice', () => {
  beforeEach(() => useSessionGoalArmStore.getState().setArmed(false));

  // handleQueueMessage builds the queued goal from consume(), so what
  // consume returns after a choice is what the queued message carries.
  test('no choice leaves the arm the composer already holds', () => {
    useSessionGoalArmStore.getState().setArmed(true, 'Typed objective', { settled: true });
    applyGoalChoice(undefined);
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: 'Typed objective', settled: true, briefAgent: false, ignoreLimit: false,
    });
  });

  test('a none choice disarms, so the queued message carries no goal', () => {
    useSessionGoalArmStore.getState().setArmed(true, 'Typed objective', { settled: true });
    applyGoalChoice({ kind: 'none' });
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: false, objectiveOverride: null, settled: false, briefAgent: false, ignoreLimit: false,
    });
  });

  test('an unchanged choice arms a settled goal with no objective', () => {
    applyGoalChoice({ kind: 'unchanged' });
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: null, settled: true, briefAgent: false, ignoreLimit: false,
    });
  });

  test('a spec sent with the message briefs the agent and keeps the length choice', () => {
    applyGoalChoice({ kind: 'spec', spec: 'Written spec', sendMode: 'with-message', ignoreLimit: true });
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: 'Written spec', settled: true, briefAgent: true, ignoreLimit: true,
    });
  });

  test('a spec sent as the message needs no briefing', () => {
    applyGoalChoice({ kind: 'spec', spec: 'Written spec', sendMode: 'goal-as-message', ignoreLimit: false });
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: 'Written spec', settled: true, briefAgent: false, ignoreLimit: false,
    });
  });
});

// ChatInput cannot be mounted in bun test: its import graph pulls the composer
// editor, Vite worker URLs and every runtime store. The call sites are guarded
// at the source, the way the neighbouring composer regression tests guard
// theirs: each exit that sends or queues must apply the choice first, or the
// queued goal takes whatever stale arm the composer happened to hold.
const chatInputLines = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'chat', 'ChatInput.tsx'),
  'utf-8',
).split('\n');

const choiceCallSites = chatInputLines
  .map((line, index) => (line.trim() === 'applyGoalChoice(options?.goal);' ? index : -1))
  .filter((index) => index >= 0);

const nextStatement = (index: number): string => {
  const line = chatInputLines.slice(index + 1).find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? '';
};

const precedingContext = (index: number): string => chatInputLines.slice(Math.max(0, index - 4), index).join('\n');

describe('ChatInput applies the goal choice at every exit', () => {
  test('the choice is applied exactly three times: two queue exits and the send', () => {
    expect(choiceCallSites).toHaveLength(3);
  });

  test('the auto-review queue exit applies the choice before queueing', () => {
    const site = choiceCallSites[0];
    expect(precedingContext(site)).toContain('autoReviewRunning');
    expect(nextStatement(site)).toBe('void handleQueueMessage(options?.presetText);');
  });

  test('the dismissed-permission and form queue exit applies the choice before queueing', () => {
    const site = choiceCallSites[1];
    expect(precedingContext(site)).toContain('deniedPermissions || dismissedForms');
    expect(nextStatement(site)).toBe('void handleQueueMessage(options?.presetText);');
  });

  test('the normal send applies the choice before sending', () => {
    const site = choiceCallSites[2];
    expect(nextStatement(site).startsWith('const sendPromise = sessionActions.sendMessage(')).toBe(true);
  });
});
