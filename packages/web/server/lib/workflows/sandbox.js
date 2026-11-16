import { Worker } from 'node:worker_threads';

import { wrapWorkflowBody } from './script.js';

const WORKER_HEAP_MB = 256;
const MAX_FAN_OUT = 4096;

const CONTEXT_PRELUDE = `
'use strict';
const host = globalThis.__host;
delete globalThis.__host;
const replayNote = ' is not available in a workflow: a resumed run replays the script and must ask for the same agents. Pass it in through args instead.';
Math.random = () => { throw new Error('Math.random()' + replayNote); };
const RealDate = Date;
globalThis.Date = new Proxy(RealDate, {
  construct(target, values) {
    if (values.length === 0) throw new Error('new Date() without a value' + replayNote);
    return new target(...values);
  },
  get(target, property) {
    if (property === 'now') return () => { throw new Error('Date.now()' + replayNote); };
    return Reflect.get(target, property);
  },
});
globalThis.agent = host.agent;
globalThis.phase = host.phase;
globalThis.log = host.log;
globalThis.parallel = async (tasks) => {
  if (!Array.isArray(tasks)) throw new TypeError('parallel(tasks) takes a list of functions that return promises');
  if (tasks.length > ${MAX_FAN_OUT}) throw new RangeError('parallel() takes at most ${MAX_FAN_OUT} tasks');
  const settled = await Promise.allSettled(tasks.map((task) => {
    if (typeof task !== 'function') return Promise.reject(new TypeError('parallel(tasks) takes functions, such as () => agent(prompt)'));
    return Promise.resolve().then(task);
  }));
  return settled.map((outcome) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    host.failed(outcome.reason);
    return null;
  });
};
// Each item runs through every stage on its own, with no wait between stages:
// one item can be in its third stage while another is in its first. A stage
// that gives null (a failed agent) ends its item there, so no agent is started
// on nothing.
globalThis.pipeline = (items, ...stages) => {
  if (!Array.isArray(items)) return Promise.reject(new TypeError('pipeline(items, ...stages) takes a list'));
  if (stages.length === 0 || stages.some((stage) => typeof stage !== 'function')) {
    return Promise.reject(new TypeError('pipeline(items, ...stages) takes one or more functions (previous, item, index) => ...'));
  }
  return globalThis.parallel(items.map((item, index) => async () => {
    let value = item;
    for (const stage of stages) {
      value = await stage(value, item, index);
      if (value === null || value === undefined) return null;
    }
    return value;
  }));
};
`;

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const vm = require('node:vm');

const pending = new Map();
let nextCallId = 0;

const call = (op, payload) => new Promise((resolve) => {
  nextCallId += 1;
  pending.set(nextCallId, resolve);
  parentPort.postMessage({ type: 'call', id: nextCallId, op, payload });
});

const toJson = (value) => {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
};

const describeError = (error) => (error && typeof error.message === 'string' ? error.message : String(error));

const start = ({ prelude, body, args, filename }) => {
  let currentPhase = null;
  const host = {
    agent: (prompt, options) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return Promise.reject(new TypeError('agent(prompt, options) needs a non-empty prompt string'));
      }
      // A phase given to the agent itself wins: inside parallel() and
      // pipeline() the global phase() may already belong to another branch.
      const own = options && typeof options.phase === 'string' && options.phase.trim() ? options.phase.trim() : null;
      return call('agent', { prompt, options: toJson(options ?? {}), phase: own ?? currentPhase });
    },
    phase: (title) => {
      currentPhase = String(title);
      parentPort.postMessage({ type: 'phase', title: currentPhase });
    },
    log: (message) => {
      parentPort.postMessage({ type: 'log', message: typeof message === 'string' ? message : JSON.stringify(toJson(message)) });
    },
    failed: (error) => {
      parentPort.postMessage({ type: 'log', message: 'A task in parallel() failed: ' + describeError(error) });
    },
  };
  const context = vm.createContext({ __host: host });
  let running;
  try {
    vm.runInContext(prelude, context, { filename: 'workflow-prelude.js' });
    // A run without args still reads them as an object, so args.x ?? fallback works.
    context.args = args === undefined ? {} : toJson(args);
    running = vm.runInContext(body, context, { filename });
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: describeError(error) });
    return;
  }
  Promise.resolve(running).then(
    (value) => parentPort.postMessage({ type: 'done', value: toJson(value) }),
    (error) => parentPort.postMessage({ type: 'error', message: describeError(error) }),
  );
};

parentPort.on('message', (message) => {
  if (message.type === 'reply') {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (resolve) resolve(message.value);
  } else if (message.type === 'start') {
    start(message);
  }
});
`;

const stoppedError = () => Object.assign(new Error('The workflow was stopped'), { stopped: true });

export const runWorkflowSandbox = ({ body, args, filename, onAgent, onPhase = () => {}, onLog = () => {} }) => {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });
  let settled = false;
  let settle;
  const result = new Promise((resolve, reject) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };
  });

  worker.on('message', (message) => {
    if (settled) return;
    if (message.type === 'call') {
      Promise.resolve()
        .then(() => onAgent(message.payload))
        .then((value) => value, () => null)
        .then((value) => {
          if (!settled) worker.postMessage({ type: 'reply', id: message.id, value: value ?? null });
        });
    } else if (message.type === 'phase') {
      onPhase(message.title);
    } else if (message.type === 'log') {
      onLog(message.message);
    } else if (message.type === 'done') {
      settle({ ok: true, value: message.value });
    } else if (message.type === 'error') {
      settle({ ok: false, error: new Error(message.message) });
    }
  });
  worker.on('error', (error) => settle({ ok: false, error }));
  worker.on('exit', () => settle({ ok: false, error: new Error('The workflow ended without a result') }));

  worker.postMessage({ type: 'start', prelude: CONTEXT_PRELUDE, body: wrapWorkflowBody(body), args, filename });

  return {
    result,
    terminate: () => settle({ ok: false, error: stoppedError() }),
  };
};
