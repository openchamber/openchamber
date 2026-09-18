import type { HostClient } from '@openchamber/sdk';
import { mountButton, mountList, mountSearchField, mountSelect, mountTextField, mountTabs } from '@openchamber/sdk/ui';
import { card, codeSample, createExample, element, feedback, metrics, paragraph, row, stack } from '../../shared.ts';
import { attachPayload, loadTasks, saveTask, type Task } from './tasks.ts';
import { mountWorkspace } from './workspace.ts';

export const mountBoard = (host: HostClient, root: Element) => {
  const app = createExample(root, { number: '02', title: 'Task Board', description: 'Turn a loose idea into a focused session. Keep the task, its context, and the work that follows in one place.', api: 'Sessions · Storage · Model' });
  const notice = feedback(app.content);
  let tasks: Task[] = []; let selectedId = ''; let query = ''; let filter = 'all'; let ready = false; let dirty = false; let busy = false;
  let title = ''; let description = ''; let status = 'Todo';
  let lastBadge = -1;
  const counts = metrics(app.content, ['Open tasks', 'In progress', 'Completed']);
  const search = mountSearchField(app.toolbar, { value: '', placeholder: 'Find a task…', onChange: (value) => { query = value; search.update({ value }); paint(); } });
  const refresh = mountButton(app.toolbar, { label: 'Refresh', variant: 'ghost', onClick: () => { void reload(); } });
  const tabs = mountTabs(app.toolbar, { activeId: 'all', items: [{ id: 'all', label: 'All tasks' }, { id: 'active', label: 'Active' }, { id: 'done', label: 'Done' }], onChange: (id) => { filter = id; tabs.update({ activeId: id }); paint(); } });
  const create = card(app.content, 'What needs doing?', 'Start with the sample tasks or add your own. A title is enough to begin.');
  const createRow = row(create); createRow.style.alignItems = 'flex-end'; let newTitle = '';
  const titleRoot = element('div', 'grow'); createRow.append(titleRoot);
  const newField = mountTextField(titleRoot, { label: 'New task', value: '', placeholder: 'Make something a little better…', onChange: (value) => { newTitle = value; newField.update({ value }); } });
  const add = mountButton(createRow, { label: 'Add task', disabled: true, onClick: () => { void notice.run(async () => {
    if (!ready || busy) return; if (!newTitle.trim()) throw new Error('Give the task a title.');
    const id = `TASK-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const task: Task = { id, title: newTitle.trim(), description: '', status: 'Todo', comments: [], kind: 'issue', url: `https://example.com/tasks/${id}`, sessions: [] };
    busy = true; add.update({ loading: true });
    try { await saveTask(host, task); tasks = [...tasks, task]; newTitle = ''; newField.update({ value: '' }); if (!dirty) choose(id); paint(); }
    finally { busy = false; add.update({ loading: false }); }
  }); } });
  const lanes = element('div', 'lanes'); app.content.append(lanes);
  const lists = ['Todo', 'In progress', 'Done'].map((lane) => {
    const body = card(lanes, lane); return { lane, list: mountList(body, { ariaLabel: `${lane} tasks`, items: [], onSelect: (id) => choose(id) }) };
  });
  const detail = card(app.content, 'Task details', 'Keep the brief useful. The agent receives this context when you start a session.');
  const identity = paragraph(detail, 'Select a task to begin', 'inline-note');
  const editor = stack(detail); editor.hidden = true;
  const titleField = mountTextField(editor, { label: 'Title', value: '', onChange: (value) => { title = value; dirty = true; titleField.update({ value }); } });
  const descriptionField = mountTextField(editor, { label: 'Brief', value: '', multiline: true, rows: 5, placeholder: 'What should change? What would a good result look like?', onChange: (value) => { description = value; dirty = true; descriptionField.update({ value }); } });
  const statusField = mountSelect(editor, { label: 'Status', value: 'Todo', options: ['Todo', 'In progress', 'Done'].map((id) => ({ id, label: id })), onChange: (value) => { status = value; dirty = true; statusField.update({ value }); } });
  const actions = row(editor);
  const commit = async (task: Task) => { await saveTask(host, task); tasks = tasks.map((entry) => entry.id === task.id ? task : entry); paint(); };
  const save = mountButton(actions, { label: 'Save changes', onClick: () => { void notice.run(async () => {
    const task = current(); if (!task || busy) return;
    if (!title.trim()) throw new Error('A task needs a title.');
    const written = { ...task, title: title.trim(), description, status };
    busy = true; save.update({ loading: true });
    try { await commit(written); if (title.trim() === written.title && description === written.description && status === written.status) dirty = false; notice.show('Changes saved', 'This task is stored on the connected instance.', 'success'); }
    finally { busy = false; save.update({ loading: false }); }
  }); } });
  mountButton(actions, { label: 'Discard edits', variant: 'ghost', onClick: () => { dirty = false; choose(selectedId); } });
  mountButton(actions, { label: 'Attach to chat', variant: 'outline', onClick: () => { void notice.run(async () => { const task = savedSelection(); if (task) { await host.attach(attachPayload(task)); notice.show('Attached', 'The task is ready in your chat composer.', 'success'); } }); } });
  const draft = mountButton(actions, { label: 'Draft a brief', variant: 'ghost', onClick: () => { void notice.run(async () => {
    if (!title.trim()) throw new Error('Give the task a title first.');
    const original = description; const owner = selectedId;
    draft.update({ loading: true });
    try { const result = await host.generate({ prompt: `${title}\n${description}`, system: 'Write a concise implementation brief with acceptance criteria. No preamble.', maxOutputTokens: 350 });
      if (owner === selectedId && original === description) { description = result.text; dirty = true; descriptionField.update({ value: description }); }
      else notice.show('Your draft changed', 'The generated brief was not applied to your newer edits.');
    } finally { draft.update({ loading: false }); }
  }); } });
  mountButton(editor, { label: 'Compose brief in chat', variant: 'ghost', size: 'xs', onClick: () => { void notice.run(() => host.compose({ text: `${title}\n${description}`, mode: 'append' })); } });
  const deleteRow = row(editor); deleteRow.hidden = true;
  paragraph(deleteRow, 'Delete this task from the board? Linked sessions will stay in OpenChamber.');
  mountButton(actions, { label: 'Delete task', variant: 'ghost', onClick: () => { deleteRow.hidden = !deleteRow.hidden; } });
  mountButton(deleteRow, { label: 'Delete permanently', variant: 'destructive', onClick: () => { void notice.run(async () => {
    const task = current(); if (!task || busy) return;
    busy = true;
    try { await saveTask(host, { ...task, deleted: true }); tasks = tasks.filter((entry) => entry.id !== task.id); dirty = false; selectedId = tasks[0]?.id ?? ''; choose(selectedId); paint(); }
    finally { busy = false; }
  }); } });
  mountButton(deleteRow, { label: 'Cancel', variant: 'ghost', onClick: () => { deleteRow.hidden = true; } });
  const linked = stack(editor);
  const linkedList = mountList(linked, { ariaLabel: 'Linked sessions', items: [], onSelect: (id) => { void notice.run(() => host.openSession(id)); } });
  paragraph(editor, 'Draft a brief uses your Small Model. Marking a task Done is always your choice.');
  const current = () => tasks.find((task) => task.id === selectedId) ?? null;
  const savedSelection = () => { if (dirty) throw new Error('Save your task edits first.'); return current(); };
  const choose = (id: string) => {
    if (dirty && id !== selectedId) { notice.show('Keep your edits', 'Save or discard the current draft before selecting another task.', 'warning'); return; }
    selectedId = id; const task = current(); editor.hidden = !task; deleteRow.hidden = true;
    if (!task) return;
    title = task.title; description = task.description ?? ''; status = task.status === 'In review' ? 'In progress' : task.status;
    identity.textContent = `${task.id} · ${task.kind === 'pull' ? 'Pull request' : 'Task'}`;
    titleField.update({ value: title }); descriptionField.update({ value: description }); statusField.update({ value: status });
    linkedList.update({ items: (task.sessions ?? []).map((session) => ({ id: session.id, title: 'Open linked session', subtitle: session.id })) });
    paint();
  };
  const paint = () => {
    counts([tasks.filter((task) => task.status !== 'Done').length, tasks.filter((task) => ['In progress', 'In review'].includes(task.status)).length, tasks.filter((task) => task.status === 'Done').length]);
    for (const { lane, list } of lists) list.update({ selectedId,
      items: tasks.filter((task) => (lane === 'In progress' ? ['In progress', 'In review'].includes(task.status) : task.status === lane)
        && (filter === 'all' || (filter === 'done' ? task.status === 'Done' : task.status !== 'Done'))
        && `${task.title} ${task.id}`.toLowerCase().includes(query.toLowerCase()))
        .map((task) => ({ id: task.id, title: task.title, subtitle: task.id, meta: task.sessions?.length ? task.sessions.length === 1 ? '1 session' : `${task.sessions.length} sessions` : undefined })) });
    const badge = tasks.filter((task) => task.status !== 'Done').length;
    if (badge !== lastBadge) { lastBadge = badge; void host.setBadge(badge).catch(() => undefined); }
  };
  const stopWorkspace = mountWorkspace(host, app.content, savedSelection, async (taskId, sessionId, projectId) => {
    const task = tasks.find((entry) => entry.id === taskId); if (!task) return;
    await commit({ ...task, sessions: [...(task.sessions ?? []), { id: sessionId, projectId }], status: task.status === 'Todo' ? 'In progress' : task.status });
    if (selectedId === taskId && !dirty) choose(taskId);
  });
  const notes = card(app.content, 'Board notes', 'A place for decisions that belong to the whole board.');
  const notesNotice = feedback(notes);
  let note = ''; let noteEdited = false;
  const noteField = mountTextField(notes, { label: 'Notes', value: '', multiline: true, rows: 3, onChange: (value) => { noteEdited = true; note = value; noteField.update({ value }); } });
  const saveNotes = mountButton(notes, { label: 'Save notes', variant: 'outline', disabled: true, onClick: () => {
    saveNotes.update({ loading: true });
    void notesNotice.run(async () => {
      try { await host.storage.set('board-notes', note); notesNotice.show('Notes saved', '', 'success'); }
      finally { saveNotes.update({ loading: false }); }
    });
  } });
  const retryNotesRoot = row(notes); retryNotesRoot.hidden = true;
  const retryNotes = mountButton(retryNotesRoot, { label: 'Retry loading notes', variant: 'ghost', onClick: () => { void loadNotes(); } });
  const loadNotes = async () => {
    retryNotes.update({ loading: true });
    try {
      const saved = await host.storage.get('board-notes');
      if (!noteEdited) { note = String(saved ?? ''); noteField.update({ value: note }); }
      saveNotes.update({ disabled: false }); retryNotesRoot.hidden = true; notesNotice.clear();
    } catch (error) { retryNotesRoot.hidden = false; notesNotice.show('Could not load notes', error instanceof Error ? error.message : String(error), 'error'); }
    finally { retryNotes.update({ loading: false }); }
  };
  codeSample(app.content, 'await host.storage.set(`task:${task.id}`, task);\nawait host.attach(taskContext);\nawait host.startSession({ ...taskContext, projectId });');
  const reload = async () => {
    if (dirty || busy) { notice.show('Keep your edits', 'Save or discard changes before refreshing.', 'warning'); return; }
    refresh.update({ loading: true });
    await notice.run(async () => {
      const collection = await loadTasks(host); tasks = collection.tasks; ready = true; add.update({ disabled: false });
      if (collection.failedKeys.length) notice.show('Some tasks could not be loaded', `Unavailable records: ${collection.failedKeys.length}. Other tasks are ready; Refresh retries the missing records.`, 'warning');
      else notice.clear();
      paint(); if (!tasks.some((task) => task.id === selectedId)) selectedId = tasks[0]?.id ?? ''; choose(selectedId);
    });
    refresh.update({ loading: false });
  };
  void reload();
  void loadNotes();
  return stopWorkspace;
};
