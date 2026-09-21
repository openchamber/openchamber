import { describe, expect, test } from 'bun:test';
import { shellCommandTransfers } from './shell-boundary.js';

describe('shellCommandTransfers', () => {
  test('names the git subcommands that reach a host', () => {
    for (const command of ['git push', 'git pull --rebase', 'git fetch origin', 'git clone https://host/a.git',
      'git ls-remote origin', 'git submodule update --init']) {
      expect(shellCommandTransfers(command)).toBe(true);
    }
  });

  test('leaves local git alone', () => {
    for (const command of ['git status', 'git log --oneline -5', 'git commit -m "fix"', 'git add -A',
      'git rebase -i HEAD~3', 'git submodule status', 'git branch -vv', 'git diff']) {
      expect(shellCommandTransfers(command)).toBe(false);
    }
  });

  test('sees past leading options, environment assignments and a path', () => {
    expect(shellCommandTransfers('git -C /repo push')).toBe(true);
    expect(shellCommandTransfers('git --git-dir /repo/.git fetch')).toBe(true);
    expect(shellCommandTransfers('GIT_TRACE=1 git push')).toBe(true);
    expect(shellCommandTransfers('/usr/local/bin/git push')).toBe(true);
    expect(shellCommandTransfers('git -c user.name=x commit -m x')).toBe(false);
  });

  test('sees a transfer hidden behind another command', () => {
    expect(shellCommandTransfers('git status && git push')).toBe(true);
    expect(shellCommandTransfers('git add -A; git commit -m x; git push origin main')).toBe(true);
    expect(shellCommandTransfers('git log | head -5')).toBe(false);
  });

  test('counts every provider CLI invocation, since talking to the host is what they are for', () => {
    expect(shellCommandTransfers('gh pr create')).toBe(true);
    expect(shellCommandTransfers('glab mr list')).toBe(true);
    expect(shellCommandTransfers('hub browse')).toBe(true);
  });

  test('ignores anything that is not a command it recognises', () => {
    for (const command of ['ls -la', 'npm test', '', '   ', 'echo "git push"'.replace('git push', 'nothing')]) {
      expect(shellCommandTransfers(command)).toBe(false);
    }
    expect(shellCommandTransfers(null)).toBe(false);
    expect(shellCommandTransfers(42)).toBe(false);
  });
});
