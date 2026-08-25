/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/3036.
 *
 * Restoring persisted agent/model pairs used to switch agents before checking
 * whether each model still existed. Several stale pairs could therefore keep
 * changing the active agent on every effect pass until React hit its nested
 * update limit. The API error belongs in the assistant message; an invalid
 * persisted pair must not mutate the current selection while it is rendered.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelControlsSource = readFileSync(join(__dirname, '..', 'ModelControls.tsx'), 'utf-8');

describe('issue #3036 stale persisted models', () => {
  test('changes the agent only after its persisted model is accepted', () => {
    const candidateLoop = modelControlsSource.slice(
      modelControlsSource.indexOf('for (const agent of agents)'),
      modelControlsSource.indexOf("return 'continue';"),
    );

    const applyIndex = candidateLoop.indexOf('const result = tryApplyModelSelection');
    const acceptedIndex = candidateLoop.indexOf("if (result === 'applied')");
    const setAgentIndex = candidateLoop.indexOf('setAgent(agent.name)');

    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(acceptedIndex).toBeGreaterThan(applyIndex);
    expect(setAgentIndex).toBeGreaterThan(acceptedIndex);
  });
});
