import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { detectDevServerCommand } from './detectDevServer';

const originalFetch = globalThis.fetch;

describe('dev server discovery from saved project actions', () => {
  beforeEach(() => {
    globalThis.fetch = async () => new Response('', { status: 404 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('skips a report command with Start-Process and finds the saved dev server', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'report', name: 'Start daily report', command: 'powershell -Command "Start-Process report-tool"' },
      { id: 'dev', name: 'Start dev server', command: 'python3 -m http.server 8000' },
    ], null);

    expect(detected?.command).toBe('python3 -m http.server 8000');
    expect(detected?.actionId).toBe('dev');
  });

  test('does not treat an unrelated saved action as a dev server', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'report', name: 'Daily report', command: 'powershell -Command "Start-Process report-tool"' },
    ], null);

    expect(detected).toBeNull();
  });

  test('falls through to a package dev script when the saved action is unrelated', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'report', name: 'Start daily report', command: 'powershell -Command "Start-Process report-tool"' },
    ], { dev: 'vite' });

    expect(detected?.command).toBe('npm run dev');
    expect(detected?.actionId).toBeUndefined();
  });

  test('finds a saved dev script even when its name does not mention a server', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'frontend', name: 'Frontend', command: 'pnpm dev' },
    ], null);

    expect(detected?.command).toBe('pnpm dev');
    expect(detected?.actionId).toBe('frontend');
  });

  test('ignores a report script named start:report in actions and package.json', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'report', name: 'Daily report', command: 'npm run start:report' },
    ], { 'start:report': 'gh workflow run daily-report.yml' });

    expect(detected).toBeNull();
  });

  test('does not run a shared workflow solely because its trusted action was renamed', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'report', name: 'Dev server', command: 'gh workflow run daily-report.yml', source: 'shared' },
    ], null);

    expect(detected).toBeNull();
  });

  test('recognizes a qualified dev server action launched from a subdirectory', async () => {
    const detected = await detectDevServerCommand('/repo', [
      { id: 'frontend', name: 'Dev server (frontend)', command: 'cd frontend && pnpm run dev', source: 'shared' },
    ], null);

    expect(detected?.command).toBe('cd frontend && pnpm run dev');
    expect(detected?.actionId).toBe('frontend');
  });
});
