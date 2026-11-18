import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAdoptionProbe, runIgnoredRaceProbe, runAncestryProbe } from './production-isolated.driver.mjs';

const root = await fs.mkdtemp('/tmp/opencode/bot-adoption-mutation-');
const worktreeUrl = new URL('./production-worktrees.js', import.meta.url);
const gitUrl = new URL('./production-git.js', import.meta.url);
const originalWorktrees = await fs.readFile(worktreeUrl, 'utf8');
const originalGit = await fs.readFile(gitUrl, 'utf8');
const absoluteImports = (source, url, replacements = new Map()) => source.replace(/from '([^']+)'/g,
  (_match, specifier) => `from '${replacements.get(specifier) ?? (specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier))}'`);
const replace = (source, before, after) => {
  assert(source.includes(before), `Mutation target changed: ${before}`);
  return source.replace(before, after);
};
try {
  await runAdoptionProbe();
  await runIgnoredRaceProbe();
  await runAncestryProbe();
  const mutants = [
    { name: 'configured host filters enabled', probe: runAdoptionProbe,
      git: replace(originalGit, "    options.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);", '    void key;'),
      worktrees: originalWorktrees, violation: /host filter/ },
    { name: 'durable adoption intent omitted', probe: runAdoptionProbe, git: originalGit,
      worktrees: replace(originalWorktrees, '// Files, index and branch stay unchanged until this descriptor exists.\n          await save(request, record);',
        '// Mutant omits the durability barrier.'), violation: /intent must be durable/ },
    { name: 'ignored-file refusal removed', probe: runIgnoredRaceProbe,
      git: replace(originalGit, "'--no-overwrite-ignore', ", ''), worktrees: originalWorktrees, violation: /Late ignored user data/ },
    { name: 'current-head ancestry omitted', probe: runAncestryProbe, git: originalGit,
      worktrees: originalWorktrees.replaceAll('await requireAncestor(record.directory, fromSha, resultSha);', ''), violation: /divergent result/ },
  ];
  const results = [];
  for (const [index, mutant] of mutants.entries()) {
    const gitFile = path.join(root, `git-${index}.mjs`);
    const worktreeFile = path.join(root, `worktrees-${index}.mjs`);
    await fs.writeFile(gitFile, absoluteImports(mutant.git, gitUrl));
    await fs.writeFile(worktreeFile, absoluteImports(mutant.worktrees, worktreeUrl,
      new Map([['./production-git.js', pathToFileURL(gitFile).href]])));
    const git = await import(pathToFileURL(gitFile).href);
    const worktrees = await import(pathToFileURL(worktreeFile).href);
    let failure;
    try { await mutant.probe({ createWorktrees: worktrees.createProductionBotWorktrees, advanceCheckout: git.advanceBotCheckout }); }
    catch (error) { failure = error; }
    assert(failure, `${mutant.name} did not turn its probe red`);
    assert.match(failure.message, mutant.violation, `${mutant.name} failed for a different reason`);
    results.push({ mutation: mutant.name, result: 'red for promised violation' });
  }
  await runAdoptionProbe();
  await runIgnoredRaceProbe();
  await runAncestryProbe();
  console.log(JSON.stringify({ original: 'green', mutants: results, restored: 'green',
    boundary: 'Disposable local module copies; no Docker or live provider claim' }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
