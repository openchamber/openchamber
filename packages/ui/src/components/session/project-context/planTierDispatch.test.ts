import { describe, expect, test } from 'bun:test';

import { buildPlanTierPrompt } from './planTierDispatch';

describe('buildPlanTierPrompt (#16 stage 2)', () => {
  const plan = { title: 'Refactor Database Layer', file: 'refactor-database-layer.md' };

  test('prefixes the tier routing command and names the plan by title and file', () => {
    expect(buildPlanTierPrompt(plan, 'cheap')).toBe(
      '/route cheap Implement the plan "Refactor Database Layer" (plan file: refactor-database-layer.md)',
    );
    expect(buildPlanTierPrompt(plan, 'frontier')).toContain('/route frontier ');
  });
});
