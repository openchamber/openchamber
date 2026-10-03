import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the component's own helper without importing the React tree.
const readHelper = (name: string): string => {
  const file = new URL('./GitView.tsx', import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isArrowFunction(node.initializer)) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`Helper not found: ${name}`);
  return ts.transpileModule(`(${found.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
};

type Target = { remoteName: string; destinationRef: string } | null;
// SAFETY: readHelper returns the transpiled source of GitView's own dirtySwitchPushTarget, whose signature this mirrors.
const target = runInNewContext(readHelper('dirtySwitchPushTarget')) as (
  branch: string, tracking: string | null, remotes: string[], fallback: string | null,
) => Target;

describe('dirty branch switch push target', () => {
  test('pushes a renamed local branch to its tracking ref, not its local name', () => {
    expect(target('my-topic', 'origin/topic', ['origin', 'upstream'], 'upstream'))
      .toEqual({ remoteName: 'origin', destinationRef: 'refs/heads/topic' });
  });

  test('keeps slashes in the tracked branch and prefers the longest remote name', () => {
    expect(target('local', 'team/fork/feature/x', ['team', 'team/fork'], 'team'))
      .toEqual({ remoteName: 'team/fork', destinationRef: 'refs/heads/feature/x' });
  });

  test('publishes an untracked branch under its own name on the fallback remote', () => {
    expect(target('fresh', null, ['origin'], 'origin')).toEqual({ remoteName: 'origin', destinationRef: 'refs/heads/fresh' });
    expect(target('fresh', 'gone/fresh', ['origin'], 'origin')).toEqual({ remoteName: 'origin', destinationRef: 'refs/heads/fresh' });
    expect(target('fresh', null, [], null)).toBeNull();
  });
});
