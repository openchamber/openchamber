import { describe, expect, test } from 'bun:test';
import { forwardTranslatedWireEvent, translateWireEvent, wireEventDirectory } from './translate-v2.js';

const wire = (type, data, extra = {}) => ({
  id: 'evt_1',
  created: 1000,
  type,
  data,
  location: { directory: '/repo' },
  ...extra,
});

describe('translateWireEvent', () => {
  test('ignores non-objects and unknown types', () => {
    expect(translateWireEvent(null)).toEqual([]);
    expect(translateWireEvent('nope')).toEqual([]);
    expect(translateWireEvent(wire('session.tool.progress', { sessionID: 's1' }))).toEqual([]);
  });

  test('tags every event with its source id and directory', () => {
    const [event] = translateWireEvent(wire('session.idle', { sessionID: 's1' }));
    expect(event.id).toBe('evt_1');
    expect(event.created).toBe(1000);
    expect(event.properties.directory).toBe('/repo');
  });

  test('server.connected and update availability pass through', () => {
    expect(translateWireEvent(wire('server.connected', {}))[0].type).toBe('server.connected');
    const [update] = translateWireEvent(wire('installation.update-available', { version: '2.1.0' }));
    expect(update).toMatchObject({ type: 'installation.update-available', properties: { version: '2.1.0' } });
  });

  test('session.created carries the directory from its location', () => {
    const [event] = translateWireEvent(wire('session.created', {
      sessionID: 's1',
      projectID: 'p1',
      parentID: 's0',
      title: 'Fix login',
      agent: 'build',
      location: { directory: '/other' },
    }));
    expect(event.type).toBe('session.created');
    expect(event.properties.info).toMatchObject({
      id: 's1',
      parentID: 's0',
      projectID: 'p1',
      directory: '/other',
      title: 'Fix login',
      agent: 'build',
    });
  });

  test('rename, move and usage all read as session.updated', () => {
    expect(translateWireEvent(wire('session.renamed', { sessionID: 's1', title: 'New' }))[0])
      .toMatchObject({ type: 'session.updated', properties: { info: { id: 's1', title: 'New' } } });
    expect(translateWireEvent(wire('session.moved', { sessionID: 's1', projectID: 'p2', location: { directory: '/moved' } }))[0])
      .toMatchObject({ type: 'session.updated', properties: { info: { id: 's1', directory: '/moved', projectID: 'p2' } } });
    expect(translateWireEvent(wire('session.usage.updated', { sessionID: 's1', cost: 0.5, tokens: { input: 10 } }))[0])
      .toMatchObject({ type: 'session.updated', properties: { info: { id: 's1', cost: 0.5 } } });
  });

  test('session.deleted keeps both the id and the legacy info shape', () => {
    const [event] = translateWireEvent(wire('session.deleted', { sessionID: 's1' }));
    expect(event).toMatchObject({ type: 'session.deleted', properties: { sessionID: 's1', info: { id: 's1' } } });
  });

  test('execution events synthesize the status vocabulary v2 no longer emits', () => {
    expect(translateWireEvent(wire('session.execution.started', { sessionID: 's1' })))
      .toMatchObject([{ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }]);

    const succeeded = translateWireEvent(wire('session.execution.succeeded', { sessionID: 's1' }));
    expect(succeeded.map((entry) => entry.type)).toEqual(['session.status', 'session.idle']);
    expect(succeeded[0].properties.status).toEqual({ type: 'idle' });
  });

  test('an interruption ends the turn without reporting a failure', () => {
    const events = translateWireEvent(wire('session.execution.interrupted', { sessionID: 's1', reason: 'user' }));
    expect(events.map((entry) => entry.type)).toEqual(['session.status', 'session.idle']);
    expect(events[1].properties).toMatchObject({ aborted: true, reason: 'user' });
    expect(events[1].properties.error.name).toBe('MessageAbortedError');
    expect(events.some((entry) => entry.type === 'session.error')).toBe(false);
  });

  test('a shutdown interruption is not an abort: the turn resumes after restart', () => {
    // OpenCode keeps the execution claim across a shutdown and continues the
    // turn on restart, so nothing here may read as the user pressing Stop.
    expect(translateWireEvent(wire('session.execution.interrupted', { sessionID: 's1', reason: 'shutdown' }))).toEqual([]);
  });

  test('a failed execution reports a structured error', () => {
    const events = translateWireEvent(wire('session.execution.failed', {
      sessionID: 's1',
      error: { type: 'ProviderAuthError', message: 'bad key', status: 401 },
    }));
    expect(events.map((entry) => entry.type)).toEqual(['session.status', 'session.error']);
    expect(events[1].properties.error).toEqual({
      name: 'ProviderAuthError',
      type: 'ProviderAuthError',
      message: 'bad key',
      status: 401,
    });
  });

  test('a passed-through session.status is kept as is', () => {
    const [event] = translateWireEvent(wire('session.status', { sessionID: 's1', status: { type: 'retry', attempt: 2 } }));
    expect(event.properties.status).toEqual({ type: 'retry', attempt: 2 });
  });

  test('an enqueued user prompt becomes a user message with text parts', () => {
    const [event] = translateWireEvent(wire('session.inbox.enqueued', {
      sessionID: 's1',
      inboxID: 'msg_1',
      item: { type: 'user', payload: { text: 'hello' } },
    }));
    expect(event.type).toBe('message.updated');
    expect(event.properties.info).toMatchObject({ id: 'msg_1', sessionID: 's1', role: 'user', text: 'hello' });
    expect(event.properties.info.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('non-user inbox items are not messages', () => {
    expect(translateWireEvent(wire('session.inbox.enqueued', {
      sessionID: 's1',
      inboxID: 'msg_1',
      item: { type: 'compaction', payload: {} },
    }))).toEqual([]);
  });

  test('steps become assistant message updates', () => {
    const [started] = translateWireEvent(wire('session.step.started', {
      sessionID: 's1',
      assistantMessageID: 'msg_2',
      agent: 'build',
      model: { id: 'gpt-5.6-luna', providerID: 'openai' },
    }));
    expect(started.properties.info).toMatchObject({
      id: 'msg_2', role: 'assistant', agent: 'build', providerID: 'openai', modelID: 'gpt-5.6-luna',
    });

    const [ended] = translateWireEvent(wire('session.step.ended', {
      sessionID: 's1', assistantMessageID: 'msg_2', finish: 'stop', cost: 1, tokens: { input: 2 },
    }));
    expect(ended.properties.info).toMatchObject({ id: 'msg_2', role: 'assistant', finish: 'stop' });
    expect(ended.properties.info.time.completed).toBe(1000);

    const [failed] = translateWireEvent(wire('session.step.failed', {
      sessionID: 's1', assistantMessageID: 'msg_2', error: { type: 'Overloaded', message: 'busy' },
    }));
    expect(failed.properties.info).toMatchObject({ finish: 'error' });
    expect(failed.properties.info.error.name).toBe('Overloaded');
  });

  test('permission requests keep the v2 action and resources', () => {
    const [event] = translateWireEvent(wire('permission.asked', {
      id: 'per_1',
      sessionID: 's1',
      action: 'bash',
      resources: ['rm -rf /'],
      source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
    }));
    expect(event.properties).toMatchObject({
      id: 'per_1', sessionID: 's1', action: 'bash', resources: ['rm -rf /'],
    });

    const [replied] = translateWireEvent(wire('permission.replied', { sessionID: 's1', requestID: 'per_1', reply: 'once' }));
    expect(replied.properties).toMatchObject({ sessionID: 's1', requestID: 'per_1' });
  });

  test('forms replace questions', () => {
    const form = { id: 'frm_1', sessionID: 's1', title: 'Switch to plan mode?', fields: [] };
    const [created] = translateWireEvent(wire('form.created', { form }));
    expect(created).toMatchObject({ type: 'form.created', properties: { sessionID: 's1', form } });

    expect(translateWireEvent(wire('form.replied', { id: 'frm_1', sessionID: 's1' }))[0])
      .toMatchObject({ type: 'form.settled', properties: { sessionID: 's1', formID: 'frm_1' } });
    expect(translateWireEvent(wire('form.cancelled', { id: 'frm_1', sessionID: 's1' }))[0])
      .toMatchObject({ type: 'form.settled', properties: { sessionID: 's1', formID: 'frm_1' } });
  });

  test('branch and mcp notices pass through', () => {
    expect(translateWireEvent(wire('vcs.branch.updated', { branch: 'main' }))[0].properties.branch).toBe('main');
    expect(translateWireEvent(wire('mcp.status.changed', { server: 'linear' }))[0].properties.server).toBe('linear');
  });

  test('events without a session id are dropped rather than half-translated', () => {
    expect(translateWireEvent(wire('session.execution.started', {}))).toEqual([]);
    expect(translateWireEvent(wire('session.step.ended', { sessionID: 's1' }))).toEqual([]);
    expect(translateWireEvent(wire('permission.asked', { sessionID: 's1' }))).toEqual([]);
  });
});

describe('wireEventDirectory', () => {
  test('reads location.directory and tolerates its absence', () => {
    expect(wireEventDirectory(wire('session.idle', { sessionID: 's1' }))).toBe('/repo');
    expect(wireEventDirectory({ type: 'session.execution.started', data: {} })).toBe('');
    expect(wireEventDirectory(null)).toBe('');
  });
});

describe('forwardTranslatedWireEvent', () => {
  test('forwards every translated event in order', () => {
    const seen = [];
    forwardTranslatedWireEvent(wire('session.execution.succeeded', { sessionID: 's1' }), (event) => seen.push(event.type));
    expect(seen).toEqual(['session.status', 'session.idle']);
  });

  test('does nothing without a handler', () => {
    expect(() => forwardTranslatedWireEvent(wire('session.idle', { sessionID: 's1' }), null)).not.toThrow();
  });
});
