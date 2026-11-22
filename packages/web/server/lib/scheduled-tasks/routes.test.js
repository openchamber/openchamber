import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerScheduledTaskRoutes } from './routes.js';

// #2156 oracle: an omitted run-history limit uses the documented
// default downstream; a supplied malformed, empty, or repeated limit
// is a 400 and never reaches listRuns; a valid integer is forwarded
// unchanged (listRuns owns the 1-1000 clamp).
const setup = () => {
  const listRuns = vi.fn(() => []);
  const app = express();
  registerScheduledTaskRoutes(app, {
    scheduledTaskRunHistory: { listRuns },
    scheduledTaskService: {},
  });
  return { app, listRuns };
};

const get = (app, query) => request(app)
  .get(`/api/projects/p1/scheduled-tasks/run-history${query}`);

describe('scheduled-tasks run-history limit parsing', () => {
  it('omitted limit forwards undefined (documented default applies)', async () => {
    const { app, listRuns } = setup();
    await get(app, '').expect(200);
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });

  it('valid limit is forwarded unchanged', async () => {
    const { app, listRuns } = setup();
    await get(app, '?limit=50').expect(200);
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('zero limit is forwarded (downstream clamps it to 1)', async () => {
    const { app, listRuns } = setup();
    await get(app, '?limit=0').expect(200);
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 0 }));
  });

  it.each([
    ['malformed', '?limit=oops'],
    ['empty', '?limit='],
    ['repeated', '?limit=10&limit=20'],
    ['fractional', '?limit=5.9'],
    ['exponent', '?limit=1e3'],
  ])('%s limit is a 400 and never reaches listRuns', async (_name, query) => {
    const { app, listRuns } = setup();
    const response = await get(app, query).expect(400);
    expect(response.body).toEqual({ error: 'limit must be a single integer' });
    expect(listRuns).not.toHaveBeenCalled();
  });
});
