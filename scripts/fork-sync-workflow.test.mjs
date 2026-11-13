import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';

const workflow = yaml.parse(fs.readFileSync(fileURLToPath(new URL('../.github/workflows/sync-upstream.yml', import.meta.url)), 'utf8'));
const steps = workflow.jobs.sync.steps;

test('clean and conflict-resolved merges share the full validation gate before publication', () => {
  const check = steps.find((step) => step.name === 'Check the integrated code');
  const push = steps.find((step) => step.name === 'Push branch and tag');
  assert.equal(check.if, "steps.merge.outputs.status == 'merged'");
  assert.ok(steps.indexOf(check) < steps.indexOf(push));
  for (const command of ['bun run check:changed', 'bun run --cwd packages/sdk test', 'bun run --cwd packages/ui test', 'bun run --cwd packages/web test', 'bun run build:web']) {
    assert.ok(check.run.includes(command));
  }
  for (const owner of ['auto-review', 'pr-watch', 'pr-fix-loop', 'session-automation', 'message-queue', 'tracked-items', 'notifications', 'session-interruption', 'opencode', 'pr-stacks', 'guests']) {
    assert.ok(check.run.includes(`server/lib/${owner}`));
  }
});

test('a modify/delete conflict refuses publication until local behavior is ported', () => {
  const merge = steps.find((step) => step.name === 'Merge upstream').run;
  const start = merge.indexOf('          if [ "${#ported[@]}" -gt 0 ]; then'.trimStart());
  const end = merge.indexOf('\nfi', start) + '\nfi'.length;
  assert.ok(start >= 0 && end > start);
  const refusal = merge.slice(start, end);
  const run = (files) => spawnSync('bash', ['-c', `give_up() { exit 42; }; ported=(${files}); ${refusal}`], { encoding: 'utf8' });
  assert.equal(run('locally-modified.js').status, 42);
  assert.equal(run('').status, 0);
});
