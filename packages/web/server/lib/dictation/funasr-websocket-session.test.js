import { describe, expect, it } from 'bun:test';
import { WebSocketServer } from 'ws';

import { FunASRWebSocketTranscriptionSession } from './funasr-websocket-session.js';

function waitFor(predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('FunASRWebSocketTranscriptionSession', () => {
  it('uses the FunASR binary protocol and forwards partial and final transcripts', async () => {
    const received = [];
    const connection = {};
    const server = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
    });

    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listening address');
    }

    server.on('connection', (socket, request) => {
      connection.protocol = socket.protocol;
      connection.authorization = request.headers.authorization;
      socket.on('message', (data, isBinary) => {
        received.push({ data: isBinary ? Buffer.from(data) : data.toString(), isBinary });
        if (isBinary) {
          socket.send(JSON.stringify({ mode: '2pass-online', text: 'partial' }));
          return;
        }
        const message = JSON.parse(data.toString());
        if (message.is_speaking === false) {
          socket.send(JSON.stringify({ mode: '2pass-offline', text: 'final' }));
        }
      });
    });

    const session = new FunASRWebSocketTranscriptionSession({
      url: `ws://127.0.0.1:${address.port}`,
      apiKey: 'test-api-key',
    });
    const transcripts = [];
    const commits = [];
    session.on('transcript', (event) => transcripts.push(event));
    session.on('committed', (event) => commits.push(event));

    try {
      await session.connect();
      session.appendPcm16(Buffer.from([1, 2, 3, 4]));
      await waitFor(() => transcripts.length === 1);
      session.commit();
      await waitFor(() => transcripts.length === 2 && commits.length === 1);

      expect(connection).toEqual({
        protocol: 'binary',
        authorization: 'Bearer test-api-key',
      });
      expect(JSON.parse(received[0].data)).toMatchObject({
        mode: '2pass',
        chunk_size: [5, 10, 5],
        chunk_interval: 10,
        encoder_chunk_look_back: 4,
        decoder_chunk_look_back: 1,
        is_speaking: true,
        audio_fs: 16000,
      });
      expect(received[1]).toEqual({ data: Buffer.from([1, 2, 3, 4]), isBinary: true });
      expect(JSON.parse(received[2].data)).toMatchObject({ is_speaking: false, is_end: true });
      expect(transcripts.map(({ transcript, isFinal }) => ({ transcript, isFinal }))).toEqual([
        { transcript: 'partial', isFinal: false },
        { transcript: 'final', isFinal: true },
      ]);
    } finally {
      session.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
