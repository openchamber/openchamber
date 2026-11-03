import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_SKILL } from './skill.js';

describe('Antigravity delegation skill', () => {
  it('declares the identity OpenCode needs', () => {
    expect(ANTIGRAVITY_SKILL.id).toBe('openchamber-antigravity');
    expect(ANTIGRAVITY_SKILL.name).toBe('antigravity-delegation');
    expect(ANTIGRAVITY_SKILL.path).toBe('/builtin/openchamber-antigravity/SKILL.md');
    expect(ANTIGRAVITY_SKILL.description.length).toBeGreaterThan(80);
    expect(ANTIGRAVITY_SKILL.description).toContain('/agy');
  });

  it('carries the body without frontmatter and covers this integration only', () => {
    const { content } = ANTIGRAVITY_SKILL;
    expect(content.startsWith('# Antigravity delegation')).toBe(true);
    expect(content.startsWith('---')).toBe(false);
    expect(content).toContain('conversation');
    expect(content).toContain('PERMISSION_DENIED');
    expect(content).toContain('MODEL_NOT_FOUND');
    // Arguments the reference skill teaches but this integration does not take.
    expect(content).not.toContain('`tier`');
    expect(content).not.toContain('`yolo`');
    expect(content).not.toContain('AGY_WORKSPACE_ROOT');
  });
});
