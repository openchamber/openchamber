import type { ActionPlan } from '@openuidev/lang-core';

export function isSupportedOpenUIAction(value: unknown): value is ActionPlan;
export function isTerminalOpenUIAction(action: ActionPlan): boolean;
