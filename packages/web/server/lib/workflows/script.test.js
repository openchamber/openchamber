import { describe, expect, it } from 'vitest';

import { parseWorkflowScript, plannedPhases } from './script.js';

const script = (body, meta = "{ name: 'audit-routes', description: 'Audit every route', phases: ['Find', 'Audit'] }") => `export const meta = ${meta}\n${body}`;

describe('parseWorkflowScript', () => {
  it('splits meta from the body', () => {
    const parsed = parseWorkflowScript(script("phase('Find')\nconst files = await agent('List files')\nreturn files"));
    expect(parsed.meta).toEqual({ name: 'audit-routes', description: 'Audit every route', phases: ['Find', 'Audit'] });
    expect(parsed.body).toContain("const files = await agent('List files')");
  });

  it('skips leading comments and reads braces inside strings', () => {
    const parsed = parseWorkflowScript(`// header\n/* block */\nexport const meta = { name: 'x', description: 'has } and { inside', phases: [] };\nreturn 1`);
    expect(parsed.meta.description).toBe('has } and { inside');
    expect(parsed.body.trim()).toBe('return 1');
  });

  it('takes the phases from phase() calls when meta lists none', () => {
    const parsed = parseWorkflowScript(script("phase('One')\nphase(\"Two\")\nreturn 1", "{ name: 'x', description: 'd' }"));
    expect(plannedPhases(parsed)).toEqual(['One', 'Two']);
  });

  it.each([
    ['no meta', 'return 1', /must start with export const meta/],
    ['a name with spaces', script('return 1', "{ name: 'Audit Routes', description: 'd' }"), /meta.name is required/],
    ['no description', script('return 1', "{ name: 'x' }"), /meta.description is required/],
    ['a computed meta', script('return 1', "{ name: 'x', description: String(1) + process }"), /plain object literal/],
    ['a syntax error', script('return (', undefined), /does not compile/],
    ['an import', script("import fs from 'node:fs'\nreturn 1"), /cannot import modules/],
    ['a phase missing from meta', script("phase('Verify')\nreturn 1"), /phase\("Verify"\) is not listed/],
  ])('refuses %s', (_, source, message) => {
    expect(() => parseWorkflowScript(source)).toThrow(message);
  });
});
