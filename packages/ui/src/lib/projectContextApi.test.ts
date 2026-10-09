import { afterAll, afterEach, expect, test } from 'bun:test';
import { createProjectTodo, deleteProjectTodo, saveProjectTodos, updateProjectNote, updateProjectPlan, updateProjectTodo, type ProjectTodoItem } from './projectContextApi';

const originalFetch = globalThis.fetch;
const project = { id: 'configured', path: '/fixture/project' };
const requests: Array<{ path: string; method: string; body: string | null }> = [];
let status = 200;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = input instanceof Request ? input.url : String(input);
  requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : null });
  if (status !== 200) return Response.json({ error: 'Concurrent change' }, { status });
  if (path.includes('/notes/')) return Response.json({ note: { id: 'n1', body: 'Draft', source: 'manual', pinned: false, createdAt: 1, updatedAt: 2 } });
  if (path.includes('/plans/')) return Response.json({ plan: { id: 'p1', file: 'plan.md', title: 'Plan', createdAt: 1, pinned: false }, raw: '# Draft' });
  if (init?.method === 'POST') {
    const todo = { id: 'created', text: 'New item', completed: false, createdAt: 1 };
    return Response.json({ todo, context: { notes: [], todos: [todo], plans: [] } });
  }
  return Response.json({ notes: [], todos: [], plans: [], sharedPlansDir: null });
}, originalFetch);

afterEach(() => { requests.length = 0; status = 200; });
// This fixture runs in its own process through the isolated test runner.
afterAll(() => { globalThis.fetch = originalFetch; });

test('ordinary todo writes send only the target item fields', async () => {
  await createProjectTodo(project, 'New item');
  await updateProjectTodo(project, 'id:1', { completed: true });
  await deleteProjectTodo(project, 'id:1');
  expect(requests.map(({ method, body }) => ({ method, body }))).toEqual([
    { method: 'POST', body: JSON.stringify({ text: 'New item' }) },
    { method: 'PATCH', body: JSON.stringify({ completed: true }) },
    { method: 'DELETE', body: null },
  ]);
  expect(requests[1].path.endsWith('/todos/id%3A1')).toBe(true);
});

test('bulk todo writes carry the confirmed snapshot separately', async () => {
  const confirmed: ProjectTodoItem[] = [{ id: 't1', text: 'Original', completed: false, createdAt: 1 }];
  const next = [{ ...confirmed[0], completed: true }];
  await saveProjectTodos(project, next, confirmed);
  expect(requests[0].body).toBe(JSON.stringify({ todos: next, expectedTodos: confirmed }));
});

test('plan writes preserve optional expectedRaw, including an empty document', async () => {
  await updateProjectPlan(project, 'p1', '# Draft', { expectedRaw: '' });
  expect(requests[0].body).toBe(JSON.stringify({ raw: '# Draft', expectedRaw: '' }));
  await updateProjectPlan(project, 'p1', '# Draft');
  expect(requests[1].body).toBe(JSON.stringify({ raw: '# Draft' }));
});

test('conditional write conflicts remain failures', async () => {
  status = 409;
  await expect(saveProjectTodos(project, [], [])).rejects.toThrow('Concurrent change');
  await expect(updateProjectPlan(project, 'p1', '# Draft', { expectedRaw: '# Original' })).rejects.toThrow('Concurrent change');
  await expect(updateProjectNote(project, 'n1', { body: 'Draft' }, { expectedBody: 'Original' })).rejects.toThrow('Concurrent change');
});

test('note text writes send the exact confirmed body and pin writes omit it', async () => {
  await updateProjectNote(project, 'n1', { body: 'Draft' }, { expectedBody: ' Original\n' });
  await updateProjectNote(project, 'n1', { pinned: true });
  expect(requests.map(request => request.body)).toEqual([
    JSON.stringify({ body: 'Draft', expectedBody: ' Original\n' }),
    JSON.stringify({ pinned: true }),
  ]);
});
