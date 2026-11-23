import http from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpaceId, hashProjectDirectory } from '../labels.js';
import { runCommand } from '../run-command.js';
import { EXT_UNCARRIABLE } from '../code-transfer.js';
import { REQUIRED_PLACE_METHODS } from './registry.js';
import type { Duplex } from 'node:stream';
import type { CommandOptions, CommandResult } from '../command-contracts.js';
import type { SpaceSpec } from '../manager.js';
import type { DockerRemovalFailure } from './docker-engine.js';

export interface ContractPlace {
  id: string;
  check: () => Promise<{ available: boolean }>;
  create: (spec: SpaceSpec) => Promise<void>;
  list: () => Promise<{ id: unknown }[]>;
  exec: (spaceId: string, argv: string[], options?: CommandOptions & { target?: string }) => Promise<CommandResult>;
  execArgv: (spaceId: string) => Promise<string[]>;
  connect: (spaceId: string) => Promise<Duplex>;
  stop: (spaceId: string) => Promise<void>;
  start: (spaceId: string) => Promise<void>;
  remove: (spaceId: string) => Promise<{ failed: DockerRemovalFailure[] }>;
  verify: (spaceId: string) => Promise<{ check: string; message: string }[]>;
}

export interface PlaceContractSuiteOptions {
  enabled?: boolean;
  setup: () => Promise<{ place: ContractPlace; dispose: () => Promise<void> }>;
}

interface StreamAnswer {
  status: number | undefined;
  body: string;
}

const CREATE_TIMEOUT_MS = 25 * 60_000;

export function runPlaceContractSuite(title: string, { enabled = true, setup }: PlaceContractSuiteOptions) {
  describe.skipIf(!enabled)(`place contract: ${title}`, () => {
    const spec = {
      id: createSpaceId(),
      name: 'Contract suite, a=b',
      project: hashProjectDirectory('/contract/suite/project'),
      created: new Date().toISOString(),
      memoryBytes: 512 * 1024 * 1024,
    };
    let place: ContractPlace;
    let dispose = async () => {};

    const listed = async () => (await place.list()).find((space) => space.id === spec.id);

    const requestOver = (stream: Duplex, path: string) => new Promise<StreamAnswer>((resolve, reject) => {
      const request = http.request({ path, headers: { host: '127.0.0.1' }, createConnection: () => stream }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end();
    });

    beforeAll(async () => {
      ({ place, dispose } = await setup());
    });

    afterAll(async () => {
      await dispose();
    });

    it('has an id and every operation', () => {
      expect(place.id).toMatch(/\S/);
      for (const method of REQUIRED_PLACE_METHODS) {
        expect(place[method]).toBeInstanceOf(Function);
      }
    });

    it('is available', async () => {
      expect(await place.check()).toMatchObject({ available: true });
    });

    it('creates a space that verifies clean', async () => {
      await place.create(spec);
      expect(await place.verify(spec.id)).toEqual([]);
    }, CREATE_TIMEOUT_MS);

    it('lists the space as running, with what it was created with', async () => {
      const { id, name, project, created } = spec;
      expect(await listed()).toEqual({ id, name, project, created, state: 'running', stoppedIdle: false, gatekeeperRunning: true, orphans: [], damaged: false, missing: [] });
    });

    it('refuses to create the same space again, and leaves it alone', async () => {
      await expect(place.create(spec)).rejects.toMatchObject({ code: 'space_name_taken' });
      expect(await listed()).toMatchObject({ state: 'running' });
    });

    it('runs commands as uid 1000', async () => {
      const result = await place.exec(spec.id, ['id', '-u']);
      expect(result).toMatchObject({ code: 0, stdout: '1000\n' });
    });

    it('runs a command in the gatekeeper, which is a container of its own', async () => {
      const space = await place.exec(spec.id, ['cat', '/etc/hostname']);
      const gatekeeper = await place.exec(spec.id, ['cat', '/etc/hostname'], { target: 'gatekeeper' });
      expect(space).toMatchObject({ code: 0 });
      expect(gatekeeper).toMatchObject({ code: 0 });
      expect(space.stdout.trim()).not.toBe('');
      expect(gatekeeper.stdout.trim()).not.toBe('');
      expect(gatekeeper.stdout.trim()).not.toBe(space.stdout.trim());

      const work = `/spaces/${spec.id}`;
      expect(await place.exec(spec.id, ['test', '-d', work])).toMatchObject({ code: 0 });
      expect((await place.exec(spec.id, ['test', '-d', work], { target: 'gatekeeper' })).code).not.toBe(0);
      expect(await place.exec(spec.id, ['id', '-u'], { target: 'gatekeeper' })).toMatchObject({ code: 0, stdout: '1000\n' });
    });

    it('knows the two exec targets and no others', async () => {
      for (const target of ['setup', 'host', '', 'space-old']) {
        await expect(place.exec(spec.id, ['id', '-u'], { target })).rejects.toMatchObject({ code: 'invalid_exec_target' });
      }
    });

    it('hands out an argv that runs a command in the space container', async () => {
      const argv = await place.execArgv(spec.id);
      expect(argv.length).toBeGreaterThan(0);
      for (const argument of argv) {
        expect(argument).toEqual(expect.any(String));
        expect(argument).not.toBe('');
        expect(argument).not.toMatch(EXT_UNCARRIABLE);
      }
      const [file, ...args] = argv;
      if (file === undefined) throw new TypeError('Missing place command executable');
      const run = (command: string[]) => runCommand(file, [...args, ...command], { timeoutMs: 60_000 });
      const hostname = await run(['cat', '/etc/hostname']);
      expect(hostname).toMatchObject({ code: 0 });
      expect(hostname.stdout).toBe((await place.exec(spec.id, ['cat', '/etc/hostname'])).stdout);
      expect(hostname.stdout).not.toBe((await place.exec(spec.id, ['cat', '/etc/hostname'], { target: 'gatekeeper' })).stdout);
    });

    it('connects to the server inside the space', async () => {
      const stream = await place.connect(spec.id);
      const answer = await requestOver(stream, '/health');
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toMatchObject({ isOpenCodeReady: true });
      const closed = new Promise((resolve) => stream.once('close', resolve));
      stream.destroy();
      await closed;
    });

    it('stops the space and lists it as exited', async () => {
      await place.stop(spec.id);
      expect(await listed()).toMatchObject({ state: 'exited', stoppedIdle: false, gatekeeperRunning: false });
    });

    it('connects to no stopped space', async () => {
      await expect(place.connect(spec.id)).rejects.toMatchObject({ code: 'space_not_running' });
    });

    it('hands out no argv for a stopped space', async () => {
      await expect(place.execArgv(spec.id)).rejects.toMatchObject({ code: 'space_not_running' });
    });

    it('starts the space again', async () => {
      await place.start(spec.id);
      expect(await listed()).toMatchObject({ state: 'running' });
      expect(await place.verify(spec.id)).toEqual([]);
    });

    it('removes the space and leaves no labelled resource behind', async () => {
      const result = await place.remove(spec.id);
      expect(result.failed).toEqual([]);
      expect(await listed()).toBeUndefined();
    });

    it('removes the gatekeeper with the space', async () => {
      await expect(place.exec(spec.id, ['cat', '/etc/hostname'], { target: 'gatekeeper' })).rejects.toThrow();
      await expect(place.exec(spec.id, ['cat', '/etc/hostname'])).rejects.toThrow();
    });

    it('hands out no argv for a space that is gone', async () => {
      await expect(place.execArgv(spec.id)).rejects.toThrow();
    });

    it('connects to no space that is gone', async () => {
      await expect(place.connect(spec.id)).rejects.toThrow();
    });

    it('treats removing a missing space as done', async () => {
      expect(await place.remove(spec.id)).toEqual({ removed: [], failed: [] });
    });
  });
}
