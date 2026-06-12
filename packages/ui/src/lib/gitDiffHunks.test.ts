import { describe, expect, test } from 'bun:test';
import { buildRevertHunkActions, findRevertHunkActionForSelection } from './gitDiffHunks';

const patch = `diff --git a/src/file.ts b/src/file.ts
index 1111111..2222222 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -2,2 +2,2 @@
-oldA
-oldB
+newA
+newB
@@ -8,1 +8,2 @@
-oldC
+newC
+newD
`;

describe('git diff hunk actions', () => {
  test('builds one reverse-apply patch per hunk', () => {
    const actions = buildRevertHunkActions('src/file.ts', patch);

    expect(actions).toHaveLength(2);
    expect(actions[0].oldRange).toEqual({ start: 2, end: 3 });
    expect(actions[0].newRange).toEqual({ start: 2, end: 3 });
    expect(actions[0].patch).toContain('--- a/src/file.ts');
    expect(actions[0].patch).toContain('@@ -2,2 +2,2 @@');
    expect(actions[0].patch).not.toContain('@@ -8,1 +8,2 @@');
    expect(actions[1].oldRange).toEqual({ start: 8, end: 8 });
    expect(actions[1].newRange).toEqual({ start: 8, end: 9 });
  });

  test('matches additions selections against new hunk ranges', () => {
    const actions = buildRevertHunkActions('src/file.ts', patch);

    const action = findRevertHunkActionForSelection(actions, {
      start: 9,
      end: 9,
      side: 'additions',
    });

    expect(action).toBe(actions[1]);
  });

  test('matches deletions selections against old hunk ranges', () => {
    const actions = buildRevertHunkActions('src/file.ts', patch);

    const action = findRevertHunkActionForSelection(actions, {
      start: 3,
      end: 3,
      side: 'deletions',
    });

    expect(action).toBe(actions[0]);
  });

  test('does not match selections outside changed hunk ranges', () => {
    const actions = buildRevertHunkActions('src/file.ts', patch);

    expect(findRevertHunkActionForSelection(actions, {
      start: 20,
      end: 20,
      side: 'additions',
    })).toBeNull();
  });
});
