import { z } from 'zod/v4';

// The official evaluator supplies ASTs. At the host action boundary, check the
// step contract before handing the original plan back to that evaluator.
const actionPlan = z.object({ steps: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('set'), target: z.string(), valueAST: z.object({ k: z.string() }) }),
  z.object({ type: z.literal('reset'), targets: z.array(z.string()) }),
  z.object({ type: z.literal('continue_conversation'), message: z.string() }),
  z.object({ type: z.literal('open_url'), url: z.string() }),
])) });

/** Only local actions or one terminal host action are valid for OpenChamber. */
export function isSupportedOpenUIAction(value) {
  const parsed = actionPlan.safeParse(value);
  if (!parsed.success || !parsed.data.steps.length) return false;
  const { steps } = parsed.data;
  const hostSteps = steps.filter((step) => step.type === 'continue_conversation' || step.type === 'open_url');
  return hostSteps.length === 0 || steps.length === 1;
}

export function isTerminalOpenUIAction(action) {
  return action.steps.some((step) => step.type === 'continue_conversation' || step.type === 'open_url');
}
