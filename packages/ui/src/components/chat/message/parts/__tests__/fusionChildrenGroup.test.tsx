import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolPartSource = readFileSync(join(__dirname, '..', 'ToolPart.tsx'), 'utf-8');

// Verifies the production component filters by runId, not just parent session.
describe('fusion children runId binding', () => {
  test('ToolPart filters fusion-children-created by runId', () => {
    expect(toolPartSource).toContain('event.runId !== runId');
    expect(toolPartSource).toContain("if (!runId || event.runId !== runId) return;");
    // Reset effect is keyed on runId so an earlier card does not inherit later children.
    expect(toolPartSource).toContain('setEventChildren({});');
    expect(toolPartSource).toContain('[runId, startTime]');
  });

  test('metadata runId is the authoritative join', () => {
    expect(toolPartSource).toContain('readOpenChamberRunId');
    expect(toolPartSource).toContain('openChamberMetadataRunId');
    expect(toolPartSource).toContain('runId={openChamberMetadataRunId}');
  });
});

type FusionEvent = {
  type: 'fusion-children-created';
  runId: string;
  sessionId: string;
  directory: string;
  children: Array<{ model: string; sessionId: string }>;
};

// Pure helper that mirrors the production predicate in ToolPart.tsx:
//   if (!runId || event.runId !== runId) return;
//   if (event.sessionId !== parentSessionId || event.directory !== directory) return;
// Extracted here so the component test does not require a full DOM.
const shouldAcceptFusionEvent = (
  event: FusionEvent | { type: string; runId?: string; sessionId?: string; directory?: string },
  runId: string,
  parentSessionId: string,
  directory: string,
): boolean => {
  if (event.type !== 'fusion-children-created') return false;
  if (!runId || (event as FusionEvent).runId !== runId) return false;
  if ((event as FusionEvent).sessionId !== parentSessionId) return false;
  if ((event as FusionEvent).directory !== directory) return false;
  return true;
};

const createFusionGroupState = (runId: string, parentSessionId: string, directory: string) => {
  let children: Record<string, { model: string }> = {};
  const handleEvent = (event: FusionEvent) => {
    if (!shouldAcceptFusionEvent(event, runId, parentSessionId, directory)) return;
    let next: Record<string, { model: string }> | null = null;
    for (const child of event.children) {
      if (children[child.sessionId]) continue;
      next ??= { ...children };
      next[child.sessionId] = { model: child.model };
    }
    if (next) children = next;
  };
  const reset = (nextRunId: string) => {
    if (nextRunId !== runId) {
      // Production resets on [runId, startTime]; simulate by clearing.
      children = {};
    }
  };
  const getChildren = () => children;
  return { handleEvent, getChildren, reset };
};

describe('OpenChamberCapabilityGroup runId isolation', () => {
  test('earlier card does not absorb later run children; later card does not see earlier children', () => {
    const directory = '/work';
    const parentSessionId = 'parent-1';
    const runIdA = 'run-a-111';
    const runIdB = 'run-b-222';

    const groupA = createFusionGroupState(runIdA, parentSessionId, directory);
    const groupB = createFusionGroupState(runIdB, parentSessionId, directory);

    // Emit children for run A — only card A should accept them.
    groupA.handleEvent({
      type: 'fusion-children-created',
      runId: runIdA,
      sessionId: parentSessionId,
      directory,
      children: [
        { model: 'anthropic/claude-sonnet-4', sessionId: 'child-a1' },
        { model: 'openai/gpt-5', sessionId: 'child-a2' },
      ],
    });
    groupB.handleEvent({
      type: 'fusion-children-created',
      runId: runIdA,
      sessionId: parentSessionId,
      directory,
      children: [
        { model: 'anthropic/claude-sonnet-4', sessionId: 'child-a1' },
        { model: 'openai/gpt-5', sessionId: 'child-a2' },
      ],
    });

    const keysAAfterFirst = Object.keys(groupA.getChildren());
    expect(keysAAfterFirst).toContain('child-a1');
    expect(keysAAfterFirst).toContain('child-a2');
    expect(Object.keys(groupB.getChildren())).toEqual([]);

    // Emit children for run B — only card B should accept them, card A unchanged.
    groupA.handleEvent({
      type: 'fusion-children-created',
      runId: runIdB,
      sessionId: parentSessionId,
      directory,
      children: [{ model: 'anthropic/claude-sonnet-4', sessionId: 'child-b1' }],
    });
    groupB.handleEvent({
      type: 'fusion-children-created',
      runId: runIdB,
      sessionId: parentSessionId,
      directory,
      children: [{ model: 'anthropic/claude-sonnet-4', sessionId: 'child-b1' }],
    });

    expect(Object.keys(groupB.getChildren())).toEqual(['child-b1']);
    expect(Object.keys(groupA.getChildren())).not.toContain('child-b1');
    expect(Object.keys(groupA.getChildren())).toContain('child-a1');

    // Duplicate delivery is idempotent.
    groupA.handleEvent({
      type: 'fusion-children-created',
      runId: runIdA,
      sessionId: parentSessionId,
      directory,
      children: [{ model: 'anthropic/claude-sonnet-4', sessionId: 'child-a1' }],
    });
    expect(Object.keys(groupA.getChildren()).filter((id) => id === 'child-a1')).toHaveLength(1);

    // Cross-directory and cross-session events are ignored.
    groupA.handleEvent({
      type: 'fusion-children-created',
      runId: runIdA,
      sessionId: 'other-parent',
      directory,
      children: [{ model: 'x/y', sessionId: 'child-other-session' }],
    });
    groupA.handleEvent({
      type: 'fusion-children-created',
      runId: runIdA,
      sessionId: parentSessionId,
      directory: '/other-dir',
      children: [{ model: 'x/y', sessionId: 'child-other-dir' }],
    });
    expect(Object.keys(groupA.getChildren())).not.toContain('child-other-session');
    expect(Object.keys(groupA.getChildren())).not.toContain('child-other-dir');
  });

  test('reset on runId change clears prior children (new part does not inherit prior run)', () => {
    const group = createFusionGroupState('run-old', 'parent-1', '/work');
    group.handleEvent({
      type: 'fusion-children-created',
      runId: 'run-old',
      sessionId: 'parent-1',
      directory: '/work',
      children: [{ model: 'a/b', sessionId: 'child-old' }],
    });
    expect(Object.keys(group.getChildren())).toContain('child-old');
    group.reset('run-new');
    expect(Object.keys(group.getChildren())).toEqual([]);
  });
});
