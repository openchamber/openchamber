import { describe, expect, it } from 'vitest';
import { getCuratedSkillsSources } from './curated-sources.js';

describe('getCuratedSkillsSources', () => {
  it('includes the Anthropic curated source', () => {
    const anthropic = getCuratedSkillsSources().find((source) => source.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic.label).toBe('Anthropic');
  });
});
