import type { ActionPlan } from '@openuidev/lang-core';
import type { z } from 'zod/v4';

export const supportedOpenUIAction: z.ZodType<{ steps: Array<
  | { type: 'set'; target: string; valueAST: { k: string } }
  | { type: 'reset'; targets: string[] }
  | { type: 'continue_conversation'; message: string }
  | { type: 'open_url'; url: string }
> }>;
export function isTerminalOpenUIAction(action: ActionPlan): boolean;
