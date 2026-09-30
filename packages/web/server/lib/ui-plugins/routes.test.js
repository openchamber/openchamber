import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { registerUIPluginRoutes } from './routes.js';

describe('UI plugin catalog routes', () => {
  test('publishes a versioned, data-only catalog', async () => {
    const app = express();
    registerUIPluginRoutes(app);
    const response = await request(app).get('/api/ui-plugins/catalog').expect(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(Array.isArray(response.body.plugins)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('javascript');
    expect(JSON.stringify(response.body)).not.toContain('bundle');
  });
});
