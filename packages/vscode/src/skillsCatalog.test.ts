import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error Bun provides this module at test runtime; the extension tsconfig intentionally omits Bun globals.
import { describe, expect, it } from 'bun:test';

import { installSkillsFromRepository, scanSkillsRepository } from './skillsCatalog';

const successfulGitResult = (stdout = '') => ({ ok: true as const, stdout, stderr: '' });

describe('VS Code skills-catalog Git execution', () => {
  it('holds one clone reservation through fallback, local commands, and cleanup', async () => {
    const events: string[] = [];
    let reservationActive = false;
    let networkActive = false;
    let destination = '';
    let preferredCloneCalls = 0;
    let fallbackCloneCalls = 0;

    const result = await scanSkillsRepository({
      source: 'openchamber/example-skills',
      defaultSubpath: 'skills',
    }, {
      reserveClone: async (target, task) => {
        destination = target;
        reservationActive = true;
        networkActive = true;
        events.push('reservation:start');
        try {
          return await task({
            kind: 'clone-reservation',
            destinationId: target,
            active: true,
            network: true,
            releaseNetwork: () => {
              networkActive = false;
              events.push('network:release');
            },
          });
        } finally {
          reservationActive = false;
          events.push('reservation:end');
        }
      },
      runGit: async (args) => {
        if (args[0] === '--version') {
          expect(reservationActive).toBe(false);
          events.push('version');
          return successfulGitResult('git version 2.50.0');
        }
        expect(reservationActive).toBe(true);
        if (args[0] === 'clone') {
          expect(networkActive).toBe(true);
          if (args.includes('--filter=blob:none')) {
            preferredCloneCalls += 1;
            events.push('clone:preferred');
            return { ok: false as const, stdout: '', stderr: 'filter unsupported', message: 'filter unsupported' };
          }
          fallbackCloneCalls += 1;
          events.push('clone:fallback');
          return successfulGitResult();
        }
        expect(networkActive).toBe(false);
        const cwd = args[0] === '-C' ? args[1]! : destination;
        if (args.includes('checkout')) {
          const skillDir = path.join(cwd, 'skills', 'demo');
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, 'SKILL.md'),
            '---\nname: demo\ndescription: Demo skill\n---\nBody\n',
            'utf8',
          );
        }
        if (args.includes('ls-files')) {
          events.push('repository:ls-files');
          return successfulGitResult('skills/demo/SKILL.md\n');
        }
        events.push('repository:command');
        return successfulGitResult();
      },
      removeDirectory: async (target) => {
        expect(reservationActive).toBe(true);
        expect(networkActive).toBe(false);
        events.push('cleanup');
        await fs.promises.rm(target, { recursive: true, force: true });
      },
    });

    expect(result).toMatchObject({
      ok: true,
      items: [{ skillName: 'demo', installable: true, description: 'Demo skill' }],
    });
    expect(preferredCloneCalls).toBe(1);
    expect(fallbackCloneCalls).toBe(1);
    expect(events.indexOf('network:release')).toBeLessThan(events.indexOf('repository:command'));
    expect(events.indexOf('cleanup')).toBeLessThan(events.indexOf('reservation:end'));
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('keeps install clone work reserved while copying selected skills', async () => {
    const projectDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-vscode-skills-test-'));
    let destination = '';
    let reservationActive = false;
    let networkReleased = false;

    try {
      const result = await installSkillsFromRepository({
        source: 'openchamber/example-skills',
        scope: 'project',
        targetSource: 'opencode',
        workingDirectory: projectDirectory,
        selections: [{ skillDir: 'skills/demo' }],
        conflictPolicy: 'overwriteAll',
      }, {
        reserveClone: async (target, task) => {
          destination = target;
          reservationActive = true;
          try {
            return await task({
              kind: 'clone-reservation',
              destinationId: target,
              active: true,
              network: true,
              releaseNetwork: () => {
                networkReleased = true;
              },
            });
          } finally {
            reservationActive = false;
          }
        },
        runGit: async (args) => {
          if (args[0] === '--version') return successfulGitResult('git version 2.50.0');
          expect(reservationActive).toBe(true);
          if (args[0] === 'clone') return successfulGitResult();
          expect(networkReleased).toBe(true);
          if (args.includes('checkout')) {
            const cwd = args[1]!;
            const skillDir = path.join(cwd, 'skills', 'demo');
            await fs.promises.mkdir(skillDir, { recursive: true });
            await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nBody\n', 'utf8');
          }
          return successfulGitResult();
        },
        removeDirectory: async (target) => {
          expect(reservationActive).toBe(true);
          await fs.promises.rm(target, { recursive: true, force: true });
        },
      });

      expect(result).toEqual({
        ok: true,
        installed: [{ skillName: 'demo', scope: 'project', source: 'opencode' }],
        skipped: [],
      });
      expect(fs.existsSync(path.join(projectDirectory, '.opencode', 'skills', 'demo', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(destination)).toBe(false);
      expect(reservationActive).toBe(false);
    } finally {
      await fs.promises.rm(projectDirectory, { recursive: true, force: true });
    }
  });

  it('cleans the temporary destination when reservation admission fails', async () => {
    let removedDestination = '';
    await expect(scanSkillsRepository({ source: 'openchamber/example-skills' }, {
      runGit: async (args) => (
        args[0] === '--version'
          ? successfulGitResult('git version 2.50.0')
          : successfulGitResult()
      ),
      reserveClone: async () => {
        throw new Error('reservation overloaded');
      },
      removeDirectory: async (target) => {
        removedDestination = target;
        await fs.promises.rm(target, { recursive: true, force: true });
      },
    })).rejects.toThrow('reservation overloaded');

    expect(removedDestination).toContain('openchamber-vscode-skills-scan-');
    expect(fs.existsSync(removedDestination)).toBe(false);
  });
});
