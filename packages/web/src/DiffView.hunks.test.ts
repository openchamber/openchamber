import { afterAll, test } from 'vitest';
import { closeDiffHunkWorkers, exerciseDiffHunkActions } from '@openchamber/ui/components/views/DiffView.hunks.fixture';

afterAll(closeDiffHunkWorkers);

// The actual view imports Vite asset globs. Run its UI-owned DOM fixture through
// the web renderer's transform pipeline instead of mocking those modules.
test('hunk actions refresh unchanged-status patches, survive full context and exclude historical diffs', () => exerciseDiffHunkActions());
test('full-context and action reads must describe the same file version', () => exerciseDiffHunkActions('cold'));
test('cached action patches cannot be paired with a newer full-context display', () => exerciseDiffHunkActions('cached'));
test('single-hunk inline actions require matching display and action versions too', () => exerciseDiffHunkActions('cold-single'));
test('split-view hunk controls occupy the matching rendered annotation rows', () => exerciseDiffHunkActions(undefined, 'side-by-side'));
