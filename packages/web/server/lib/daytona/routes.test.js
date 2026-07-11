import { beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import express from 'express';

import { registerDaytonaRoutes } from './routes.js';

describe('Daytona routes', () => {
  let app;
  let request;
  let mockLifecycle;
  let mockRegistry;
  let mockMonitor;
  let mockBridge;
  let mockDaytonaService;
  let logger;

  beforeEach(() => {
    app = express();

    mockLifecycle = {
      createSandbox: vi.fn(async (sessionId) => ({
        sandboxId: `sbx-${sessionId}`,
        openCodeUrl: `http://localhost:4000/${sessionId}`,
      })),
      destroySandbox: vi.fn(async () => {}),
    };

    mockRegistry = {
      get: vi.fn((sessionId) => null),
      listActive: vi.fn(() => []),
    };

    mockMonitor = {
      resetTimer: vi.fn(),
    };

    mockBridge = {
      disconnect: vi.fn(),
      isConnected: vi.fn(() => false),
    };

    mockDaytonaService = {
      lifecycle: mockLifecycle,
      registry: mockRegistry,
      monitor: mockMonitor,
      bridge: mockBridge,
    };

    logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    registerDaytonaRoutes(app, { daytonaService: mockDaytonaService, logger });
    request = supertest(app);
  });

  describe('POST /api/daytona/sandbox', () => {
    it('returns 201 with sandbox info for valid sessionId', async () => {
      const res = await request
        .post('/api/daytona/sandbox')
        .send({ sessionId: 'session-abc' })
        .expect(201);

      expect(res.body.sandboxId).toBe('sbx-session-abc');
      expect(res.body.status).toBe('active');
      expect(res.body.openCodeUrl).toBe('http://localhost:4000/session-abc');
      expect(mockLifecycle.createSandbox).toHaveBeenCalledWith('session-abc');
      expect(mockMonitor.resetTimer).toHaveBeenCalledWith('session-abc');
    });

    it('returns 400 when sessionId is missing', async () => {
      const res = await request
        .post('/api/daytona/sandbox')
        .send({})
        .expect(400);

      expect(res.body.error).toMatch(/sessionId is required/);
    });

    it('returns 400 when sessionId is not a string', async () => {
      const res = await request
        .post('/api/daytona/sandbox')
        .send({ sessionId: 123 })
        .expect(400);

      expect(res.body.error).toMatch(/sessionId is required/);
    });

    it('returns 500 when lifecycle.createSandbox throws', async () => {
      mockLifecycle.createSandbox.mockRejectedValueOnce(new Error('Daytona API unavailable'));

      const res = await request
        .post('/api/daytona/sandbox')
        .send({ sessionId: 'session-abc' })
        .expect(500);

      expect(res.body.error).toBe('Failed to create sandbox');
      expect(res.body.detail).toBe('Daytona API unavailable');
    });
  });

  describe('DELETE /api/daytona/sandbox/:sessionId', () => {
    it('returns 200 when sandbox exists', async () => {
      mockRegistry.get.mockReturnValueOnce({
        sessionId: 'session-abc',
        sandboxId: 'sbx-123',
        status: 'active',
      });

      const res = await request
        .delete('/api/daytona/sandbox/session-abc')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.sessionId).toBe('session-abc');
      expect(mockLifecycle.destroySandbox).toHaveBeenCalledWith('session-abc');
      expect(mockBridge.disconnect).toHaveBeenCalledWith('session-abc');
    });

    it('returns 404 when sandbox does not exist', async () => {
      mockRegistry.get.mockReturnValueOnce(null);

      const res = await request
        .delete('/api/daytona/sandbox/unknown-session')
        .expect(404);

      expect(res.body.error).toMatch(/No sandbox found/);
    });

    it('returns 500 when lifecycle.destroySandbox throws', async () => {
      mockRegistry.get.mockReturnValueOnce({
        sessionId: 'session-abc',
        sandboxId: 'sbx-123',
        status: 'active',
      });
      mockLifecycle.destroySandbox.mockRejectedValueOnce(new Error('Destroy failed'));

      const res = await request
        .delete('/api/daytona/sandbox/session-abc')
        .expect(500);

      expect(res.body.error).toBe('Failed to destroy sandbox');
    });
  });

  describe('GET /api/daytona/sandbox/:sessionId/status', () => {
    it('returns 200 with sandbox info for existing sandbox', async () => {
      mockRegistry.get.mockReturnValueOnce({
        sessionId: 'session-abc',
        sandboxId: 'sbx-123',
        status: 'active',
        openCodeUrl: 'http://localhost:4000/session-abc',
        createdAt: 1700000000000,
        lastActivityAt: 1700000001000,
      });
      mockBridge.isConnected.mockReturnValueOnce(true);

      const res = await request
        .get('/api/daytona/sandbox/session-abc/status')
        .expect(200);

      expect(res.body.sessionId).toBe('session-abc');
      expect(res.body.sandboxId).toBe('sbx-123');
      expect(res.body.status).toBe('active');
      expect(res.body.openCodeUrl).toBe('http://localhost:4000/session-abc');
      expect(res.body.createdAt).toBe(1700000000000);
      expect(res.body.lastActivityAt).toBe(1700000001000);
      expect(res.body.bridgeConnected).toBe(true);
    });

    it('returns 404 for unknown session', async () => {
      mockRegistry.get.mockReturnValueOnce(null);

      const res = await request
        .get('/api/daytona/sandbox/unknown/status')
        .expect(404);

      expect(res.body.error).toMatch(/No sandbox found/);
    });
  });

  describe('GET /api/daytona/sandboxes', () => {
    it('returns 200 with an array of active sandboxes', async () => {
      mockRegistry.listActive.mockReturnValueOnce([
        {
          sessionId: 'session-1',
          sandboxId: 'sbx-1',
          status: 'active',
          createdAt: 1700000000000,
          lastActivityAt: 1700000001000,
        },
        {
          sessionId: 'session-2',
          sandboxId: 'sbx-2',
          status: 'active',
          createdAt: 1700000002000,
          lastActivityAt: 1700000003000,
        },
      ]);

      const res = await request
        .get('/api/daytona/sandboxes')
        .expect(200);

      expect(res.body.count).toBe(2);
      expect(res.body.sandboxes).toHaveLength(2);
      expect(res.body.sandboxes[0].sessionId).toBe('session-1');
      expect(res.body.sandboxes[1].sessionId).toBe('session-2');
    });

    it('returns 200 with empty array when no active sandboxes', async () => {
      mockRegistry.listActive.mockReturnValueOnce([]);

      const res = await request
        .get('/api/daytona/sandboxes')
        .expect(200);

      expect(res.body.count).toBe(0);
      expect(res.body.sandboxes).toHaveLength(0);
    });
  });

  describe('POST /api/daytona/sandbox/:sessionId/activity', () => {
    it('returns 200 and resets the timer for existing sandbox', async () => {
      mockRegistry.get.mockReturnValueOnce({
        sessionId: 'session-abc',
        sandboxId: 'sbx-123',
        status: 'active',
      });

      const res = await request
        .post('/api/daytona/sandbox/session-abc/activity')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.sessionId).toBe('session-abc');
      expect(res.body.lastActivityAt).toBeTypeOf('number');
      expect(mockMonitor.resetTimer).toHaveBeenCalledWith('session-abc');
    });

    it('returns 404 for unknown session', async () => {
      mockRegistry.get.mockReturnValueOnce(null);

      const res = await request
        .post('/api/daytona/sandbox/unknown/activity')
        .expect(404);

      expect(res.body.error).toMatch(/No sandbox found/);
    });
  });
});
