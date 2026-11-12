import type { HostClient, GuestSessionWorktree } from '@openchamber/sdk';
import { mountButton, mountList, mountSelect, mountTextField } from '@openchamber/sdk/ui';
import { card, codeSample, element, feedback, paragraph, stack } from '../../shared.ts';
import { attachPayload, type Task } from './tasks.ts';

export const mountWorkspace = (host: HostClient, parent: Element, selected: () => Task | null, created: (taskId: string, sessionId: string, projectId: string) => Promise<void>) => {
  const grid = element('div', 'split workspace'); parent.append(grid);
  const controls = card(grid, 'Run with an agent', 'Choose where the work happens. Starting a session keeps this board open.');
  const activity = card(grid, 'Live sessions', 'Idle means the agent stopped. You decide when the task is done.');
  const notice = feedback(controls);
  let projectId = ''; let destination = 'root'; let branchName = ''; let baseBranch = ''; let generation = 0; let disposed = false;
  let stopSessions = () => {}; let stopWorktrees = () => {}; let stopProjects = () => {};
  const sessions = mountList(activity, { ariaLabel: 'Live sessions', items: [], onSelect: (id) => { void notice.run(() => host.openSession(id)); } });
  const projectsRoot = stack(controls);
  const worktree = mountSelect(controls, { label: 'Session directory', value: 'root', options: [{ id: 'root', label: 'Project root' }, { id: 'new', label: 'New worktree' }], onChange: (value) => { destination = value; worktree.update({ value }); branchFields.hidden = value !== 'new'; } });
  const branchFields = stack(controls); branchFields.hidden = true;
  const branch = mountTextField(branchFields, { label: 'Branch name', value: '', placeholder: 'fix/login-redirect', onChange: (value) => { branchName = value; branch.update({ value }); } });
  const base = mountTextField(branchFields, { label: 'Base branch', value: '', placeholder: 'Use the project default', onChange: (value) => { baseBranch = value; base.update({ value }); } });
  const reset = () => {
    generation++; stopSessions(); stopWorktrees(); destination = 'root'; branchFields.hidden = true;
    sessions.update({ items: [] }); worktree.update({ value: 'root', options: [{ id: 'root', label: 'Project root' }, { id: 'new', label: 'New worktree' }] });
  };
  const selectProject = async (id: string) => {
    reset(); projectId = id; projects.update({ value: id }); const owner = generation;
    const release = await host.onSessions(id, (snapshot) => {
      if (owner !== generation || disposed) return;
      sessions.update({ items: snapshot.sessions.map((session) => ({ id: session.id, title: session.title,
        subtitle: `${session.worktree?.branch ?? 'Project root'}${session.outcome ? ` · ${session.outcome}` : ''}`, badge: { label: session.activity, tone: session.activity === 'running' ? 'info' : 'neutral' } })) });
      if (snapshot.state === 'error') notice.show('Some sessions are unavailable', 'Showing the sessions the host can still provide.', 'warning');
    });
    if (owner !== generation || disposed) { release(); return; } stopSessions = release;
    const releaseWorktrees = await host.onWorktrees(id, (snapshot) => {
      if (owner !== generation || disposed) return;
      worktree.update({ options: [{ id: 'root', label: 'Project root' }, { id: 'new', label: 'New worktree' }, ...snapshot.worktrees.map((entry) => ({ id: entry.directory, label: entry.name, hint: entry.status, disabled: entry.status !== 'ready' }))] });
      if (snapshot.state === 'ready' && !['root', 'new'].includes(destination) && !snapshot.worktrees.some((entry) => entry.directory === destination && entry.status === 'ready')) {
        destination = 'root'; worktree.update({ value: destination });
      }
    });
    if (owner !== generation || disposed) releaseWorktrees(); else stopWorktrees = releaseWorktrees;
  };
  const projects = mountSelect(projectsRoot, { label: 'Project', value: '', searchable: true, options: [], onChange: (id) => { void notice.run(() => selectProject(id)); } });
  const start = mountButton(controls, { label: 'Start session', onClick: () => {
    void notice.run(async () => {
      const task = selected(); const project = projectId;
      if (!task || !project) throw new Error('Select a saved task and a project first.');
      let target: GuestSessionWorktree = false;
      if (destination === 'new') {
        target = { kind: 'new' };
        if (branchName.trim()) target.name = branchName.trim();
        if (baseBranch.trim()) target.baseBranch = baseBranch.trim();
      }
      else if (destination !== 'root') target = { kind: 'existing', directory: destination };
      start.update({ loading: true });
      try {
        const result = await host.startSession({ ...attachPayload(task), projectId: project, worktree: target });
        if (result.sessionId === null) { notice.show('Worktree kept for recovery', `${result.failure}. ${result.directory}`, 'warning'); return; }
        try { await created(task.id, result.sessionId, project); }
        catch {
          notice.show('Session created, task link not saved', `Session ${result.sessionId} exists. Open it from Live sessions; the task record could not be updated.`, 'warning');
          return;
        }
        const complete = result.sent === 'sent' && result.linked !== false;
        notice.show('Session created', complete ? 'Your agent has the task context. Follow its progress in Live sessions.' : `Initial message: ${result.sent}. Task context linked: ${result.linked === false ? 'no' : 'yes'}. Open the session to continue.`, complete ? 'success' : 'warning');
      } finally { start.update({ loading: false }); }
    });
  } });
  paragraph(controls, 'Starting an agent can use tokens and run tools.');
  codeSample(controls, 'await host.startSession({ ...task, projectId, worktree });\nawait host.onSessions(projectId, updateSessions);');
  void notice.run(async () => {
    const stop = await host.onProjects((snapshot) => {
      if (disposed) return;
      if (snapshot.state !== 'ready') { notice.show(`Projects: ${snapshot.state}`, 'Keeping the current selection until the host is ready.', snapshot.state === 'error' ? 'warning' : 'info'); return; }
      projects.update({ options: snapshot.projects.map((project) => ({ id: project.id, label: project.name })) });
      if (!snapshot.projects.some((project) => project.id === projectId)) {
        const first = snapshot.projects[0];
        if (first) void notice.run(() => selectProject(first.id));
        else { reset(); projectId = ''; projects.update({ value: '' }); notice.show('No projects yet', 'Add a project in OpenChamber, then return here.'); }
      }
    });
    if (disposed) stop(); else stopProjects = stop;
  });
  return () => { disposed = true; reset(); stopProjects(); };
};
