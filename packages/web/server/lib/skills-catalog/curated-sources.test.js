import { describe, expect, it } from 'vitest';
import { getCuratedSkillsSources } from './curated-sources.js';

describe('getCuratedSkillsSources', () => {
  it('labels the ClawHub curated source as ClawHub', () => {
    const clawhub = getCuratedSkillsSources().find((source) => source.id === 'clawdhub');
    expect(clawhub).toBeDefined();
    expect(clawhub.label).toBe('ClawHub');
  });
});
