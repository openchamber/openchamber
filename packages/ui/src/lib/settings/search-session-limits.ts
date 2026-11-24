import type { SettingsSearchItem } from './search';

export const SESSION_GOAL_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'chat.session-goal',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.sessionGoal',
    keywords: ['goal', 'objective', 'auto continue'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.session-goal-checker',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.goal.checkerLabel',
    keywords: ['goal', 'progress', 'check', 'jev', 'classification', 'small model'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.session-goal-max-turns',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.goal.maxTurnsLabel',
    keywords: ['goal', 'turns', 'limit', 'continuations', 'safety'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.session-goal-budget',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.goal.budgetLabel',
    keywords: ['goal', 'budget', 'tokens', 'limit'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
];

export const SESSION_COST_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'sessions.cost-alerts',
    page: 'sessions',
    titleKey: 'settings.openchamber.sessionCost.field.enabled',
    descriptionKey: 'settings.openchamber.sessionCost.field.enabledInfo',
    keywords: ['cost', 'spend', 'budget', 'price', 'usd', 'dollars', 'threshold', 'limit', 'alert'],
  },
];
