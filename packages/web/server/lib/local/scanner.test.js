import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalIssueError } from './files.js';
import { createLocalScanner } from './scanner.js';

const issue = (n, title, state = 'todo', extra = '') => `---
identifier: LOCAL-${n}
title: ${title}
state: ${state}
priority: null
labels: []
assignee: null
createdAt: 2026-11-01T08:00:00Z
updatedAt: 2026-11-01T08:00:00Z
feature: null
blockedBy: []
${extra}---

Body of ${title}.
`;

let root;
let project;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scan-'));
  project = { id: 'proj-1', path: root, label: 'Proj One' };
});

const scannerWith = async () => createLocalScanner({ listProjects: async () => [project] });

describe('list', () => {
  it('reads issues from .issues, filters by state and query, paginates', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `LOCAL-${n}-t.md`), issue(n, `Title ${n}`, n === 3 ? 'done' : 'todo'));
    const scanner = await scannerWith();
    const open = await scanner.list({ state: 'open' });
    expect(open.issues.map((i) => i.identifier)).toEqual(['LOCAL-1', 'LOCAL-2']);
    const all = await scanner.list({ state: 'all', query: 'title 2' });
    expect(all.issues.map((i) => i.identifier)).toEqual(['LOCAL-2']);
    const page = await scanner.list({ state: 'all', cursor: Buffer.from(JSON.stringify({ offset: 2 })).toString('base64') });
    expect(page.issues).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });
  it('ignores a duplicated identifier and warns', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'First'));
    fs.writeFileSync(path.join(dir, 'LOCAL-1-b.md'), issue(1, 'Copy'));
    const warn = console.warn; console.warn = () => {};
    try {
      const scanner = await scannerWith();
      const { issues } = await scanner.list({ state: 'all' });
      expect(issues).toHaveLength(1);
      expect(issues[0].title).toBe('First');
    } finally { console.warn = warn; }
  });
  it('returns empty for a missing dir and a project that is unreadable', async () => {
    project.path = path.join(root, 'nonexistent');
    const scanner = await scannerWith();
    expect((await scanner.list({ state: 'all' })).issues).toEqual([]);
  });
  it('keys containerByIssue by project when two projects both have LOCAL-1', async () => {
    const dirOne = path.join(root, 'one', '.issues');
    const dirTwo = path.join(root, 'two', '.issues');
    fs.mkdirSync(dirOne, { recursive: true });
    fs.mkdirSync(dirTwo, { recursive: true });
    fs.writeFileSync(path.join(dirOne, 'LOCAL-1-a.md'), issue(1, 'One'));
    fs.writeFileSync(path.join(dirTwo, 'LOCAL-1-a.md'), issue(1, 'Two'));
    const projects = [
      { id: 'proj-1', path: path.join(root, 'one'), label: 'Proj One' },
      { id: 'proj-2', path: path.join(root, 'two'), label: 'Proj Two' },
    ];
    const scanner = createLocalScanner({ listProjects: async () => projects });

    const { issues, containerByIssue } = await scanner.list({ state: 'all' });
    expect(issues.map((i) => [i.identifier, i.title, i.containerId])).toEqual([
      ['LOCAL-1', 'One', 'proj-1'],
      ['LOCAL-1', 'Two', 'proj-2'],
    ]);
    expect(containerByIssue.get('proj-1')).toEqual({ id: 'proj-1', name: 'Proj One' });
    expect(containerByIssue.get('proj-2')).toEqual({ id: 'proj-2', name: 'Proj Two' });
    for (const issue of issues) {
      expect(containerByIssue.get(issue.containerId)).toEqual({ id: issue.containerId, name: issue.containerId === 'proj-1' ? 'Proj One' : 'Proj Two' });
    }

    // get stays first-project-wins: the first project holding LOCAL-1 resolves.
    const found = await scanner.get('LOCAL-1');
    expect(found.issue.title).toBe('One');
    expect(found.issue.containerId).toBe('proj-1');
    expect(found.container).toEqual({ id: 'proj-1', name: 'Proj One' });
  });
});

describe('create', () => {
  it('mkdirs a missing dir and allocates max+1, honoring blockedBy/feature fields', async () => {
    const scanner = await scannerWith();
    const created = await scanner.create('proj-1', { title: 'New one', description: 'Desc', priority: 'high', labels: ['bug'], feature: 'login', blockedBy: ['LOCAL-2'] });
    expect(created.identifier).toBe('LOCAL-1');
    expect(fs.existsSync(path.join(root, '.issues', 'LOCAL-1-new-one.md'))).toBe(true);
    const second = await scanner.create('proj-1', { title: 'Second', description: null, priority: null, labels: [] });
    expect(second.identifier).toBe('LOCAL-2');
  });
  it('retries when the target file already exists (lost race)', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-taken.md'), issue(1, 'Taken'));
    const scanner = await scannerWith();
    const created = await scanner.create('proj-1', { title: 'Racer', description: null, priority: null, labels: [] });
    expect(created.identifier).toBe('LOCAL-2');
  });
  it('rejects an unknown container', async () => {
    const scanner = await scannerWith();
    await expect(scanner.create('nope', { title: 'X', description: null, priority: null, labels: [] })).rejects.toThrow(LocalIssueError);
  });
});

describe('edit and updateState', () => {
  it('edits fields and body, bumps updatedAt, preserves unknown keys and comments', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'Old', 'todo', 'custom: keep\n'));
    const scanner = await scannerWith();
    const edited = await scanner.edit('LOCAL-1', { title: 'New', description: 'New body', priority: 'low', labels: ['x'] });
    expect(edited.title).toBe('New');
    expect(edited.state).toBe('todo');
    const raw = fs.readFileSync(path.join(dir, 'LOCAL-1-a.md'), 'utf8');
    expect(raw).toContain('custom: keep');
    expect(raw).toContain('New body');
  });
  it('moves state and rejects unknown identifier or state', async () => {
    const dir = path.join(root, '.issues');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T'));
    const scanner = await scannerWith();
    expect((await scanner.updateState('LOCAL-1', 'done')).state).toBe('done');
    await expect(scanner.updateState('LOCAL-9', 'done')).rejects.toThrow(LocalIssueError);
    await expect(scanner.updateState('LOCAL-1', 'nope')).rejects.toThrow(LocalIssueError);
  });
});

it('liveSummaries includes state.type for the alias window', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T', 'in-progress'));
  const scanner = await scannerWith();
  const [summary] = await scanner.liveSummaries(['LOCAL-1']);
  expect(summary.state).toEqual({ name: 'in-progress', category: 'in-progress', type: 'in-progress' });
});

it('states exposes the six categories with positions', async () => {
  const scanner = await scannerWith();
  const states = scanner.states();
  expect(states.map((s) => s.id)).toEqual(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']);
  expect(states.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
});

it('get returns the issue with its container, null when unknown', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'T'));
  const scanner = await scannerWith();
  const found = await scanner.get('LOCAL-1');
  expect(found.issue.title).toBe('T');
  expect(found.issue.containerId).toBe('proj-1');
  expect(found.container).toEqual({ id: 'proj-1', name: 'Proj One' });
  expect(await scanner.get('LOCAL-9')).toBeNull();
});

it('containers lists projects with a readable dir and honors a valid custom issuesDir', async () => {
  const custom = path.join(root, 'custom-issues');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'LOCAL-1-c.md'), issue(1, 'Custom'));
  project.issuesDir = 'custom-issues';
  const scanner = await scannerWith();
  expect(await scanner.containers()).toEqual([{ id: 'proj-1', name: 'Proj One' }]);
  const { issues } = await scanner.list({ state: 'all' });
  expect(issues.map((i) => i.identifier)).toEqual(['LOCAL-1']);
  expect(await scanner.get('LOCAL-1')).not.toBeNull();
});

it('falls back to .issues when issuesDir escapes the project or is empty', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'LOCAL-1-a.md'), issue(1, 'Safe'));
  for (const bad of ['../outside', '  ', '/abs/dir']) {
    project.issuesDir = bad;
    const scanner = await scannerWith();
    const { issues } = await scanner.list({ state: 'all' });
    expect(issues.map((i) => i.identifier)).toEqual(['LOCAL-1']);
  }
});

it('cursor round-trips through list pages', async () => {
  const dir = path.join(root, '.issues');
  fs.mkdirSync(dir);
  for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(dir, `LOCAL-${n}-t.md`), issue(n, `T ${n}`));
  const scanner = await scannerWith();
  const first = await scanner.list({ state: 'all' });
  expect(first.issues).toHaveLength(3);
  expect(first.hasMore).toBe(false);
  expect(first.cursor).toBeNull();
  const paged = await scanner.list({ state: 'all', cursor: first.cursor });
  expect(paged.issues).toHaveLength(3);
});
