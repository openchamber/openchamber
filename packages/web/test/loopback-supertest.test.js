import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

// The setup file `loopback-supertest.js` is what this checks: a server bound
// to every interface lets another process on 127.0.0.1 answer the request.
describe('supertest servers in the web suite', () => {
  it('listen on the loopback address the request goes to, and only there', async () => {
    const app = express();
    app.get('/where', (req, res) => res.json({ address: req.socket.server.address() }));

    const { body } = await request(app).get('/where').query({ probe: 1 }).expect(200);

    expect(body.address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(body.address.port).toBeGreaterThan(0);
  });

  it('closes the server it started once the response is in', async () => {
    let server;
    const app = express();
    app.get('/', (req, res) => {
      server = req.socket.server;
      res.end('ok');
    });

    await request(app).get('/').expect(200);

    expect(server.listening).toBe(false);
  });
});
