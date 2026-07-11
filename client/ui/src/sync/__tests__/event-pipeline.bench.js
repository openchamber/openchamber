/**
 * Synthetic benchmark for the event pipeline.
 *
 * Measures how much per-directory queueing + delta coalescing shrinks the
 * delivered event stream and how long enqueue/flush takes for realistic
 * multi-session workloads (parent + subagent token streaming).
 *
 * Run with:
 *   bun packages/ui/src/sync/__tests__/event-pipeline.bench.js
 *
 * This is NOT a bun:test file — it prints a report and exits. Nothing here
 * asserts; it exists purely to give you intuition about the optimization
 * impact at varying concurrency levels.
 */

import { createEventPipeline } from '../event-pipeline.ts';

// ---------------------------------------------------------------------------
// Minimal DOM stubs (same approach as the unit tests)
// ---------------------------------------------------------------------------

globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
};

// ---------------------------------------------------------------------------
// SDK mock that replays a pre-generated event list
// ---------------------------------------------------------------------------

function createReplaySdk(events, hold) {
  return {
    global: {
      event: async () => ({
        stream: (async function* () {
          for (const e of events) yield e;
          await hold;
        })(),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Workload generators
// ---------------------------------------------------------------------------

/**
 * Token-stream workload: N sessions in `directoryCount` directories, each
 * emitting `tokensPerSession` text deltas plus a few framing events.
 *
 * Shape is intentionally close to a real opencode session:
 *   session.status(busy)
 *   message.part.delta × tokensPerSession   (coalescible)
 *   message.part.updated                    (final state)
 *   session.status(idle)
 */
function buildTokenStreamWorkload({
  directoryCount,
  sessionsPerDirectory,
  tokensPerSession,
}) {
  const events = [];
  for (let d = 0; d < directoryCount; d++) {
    const directory = `dir-${d}`;
    for (let s = 0; s < sessionsPerDirectory; s++) {
      const sessionID = `dir-${d}-s${s}`;
      const messageID = `${sessionID}-m1`;
      const partID = `${messageID}-p1`;

      events.push({
        directory,
        payload: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } },
        },
      });

      for (let t = 0; t < tokensPerSession; t++) {
        events.push({
          directory,
          payload: {
            type: 'message.part.delta',
            properties: {
              messageID,
              partID,
              field: 'text',
              delta: 'x',
            },
          },
        });
      }

      events.push({
        directory,
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: partID,
              type: 'text',
              messageID,
              text: 'x'.repeat(tokensPerSession),
            },
          },
        },
      });

      events.push({
        directory,
        payload: {
          type: 'session.status',
          properties: { sessionID, status: { type: 'idle' } },
        },
      });
    }
  }

  // Interleave events across directories/sessions so we exercise the real
  // "parent + subagent" arrival pattern instead of one session at a time.
  return interleave(events);
}

// Shuffle events within each directory bucket so arrivals are interleaved but
// still ordered within a single (sessionID, partID) stream (deltas must stay
// ordered relative to each other for append semantics to remain correct).
function interleave(events) {
  const buckets = new Map(); // directory -> list of events (in original order)
  for (const e of events) {
    const bucket = buckets.get(e.directory) ?? [];
    bucket.push(e);
    buckets.set(e.directory, bucket);
  }
  const out = [];
  let more = true;
  while (more) {
    more = false;
    for (const bucket of buckets.values()) {
      if (bucket.length > 0) {
        out.push(bucket.shift());
        more = true;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner — pushes a workload through the pipeline and measures
// ---------------------------------------------------------------------------

async function runScenario(label, workload) {
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });

  let delivered = 0;
  let deliveredDeltas = 0;
  let deliveredDeltaBytes = 0;

  const sdk = createReplaySdk(workload, hold);

  const startWall = performance.now();
  const { cleanup } = createEventPipeline({
    sdk,
    onEvent: (_directory, payload) => {
      delivered++;
      if (payload.type === 'message.part.delta') {
        deliveredDeltas++;
        deliveredDeltaBytes += payload.properties.delta.length;
      }
    },
  });

  // Give the pipeline enough time to finish enqueueing AND flush. Scale wait
  // time with workload so large stress scenarios have room to drain — the SSE
  // loop yields every 8ms and the flush fires every 16ms, so in the worst case
  // we need ~(workload / STREAM_YIELD) * 16ms of wall clock.
  const waitMs = Math.max(200, Math.ceil(workload.length / 100));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const endWall = performance.now();

  cleanup();
  release();

  // Count input-side delta events for comparison
  const inputDeltas = workload.filter((e) => e.payload.type === 'message.part.delta').length;
  const inputDeltaBytes = workload
    .filter((e) => e.payload.type === 'message.part.delta')
    .reduce((n, e) => n + e.payload.properties.delta.length, 0);

  const wallMs = endWall - startWall;
  const reductionPct = inputDeltas === 0 ? 0 : (1 - deliveredDeltas / inputDeltas) * 100;

  return {
    label,
    inputEvents: workload.length,
    inputDeltas,
    inputDeltaBytes,
    deliveredEvents: delivered,
    deliveredDeltas,
    deliveredDeltaBytes,
    reductionPct,
    wallMs,
  };
}

function formatRow(r) {
  const cols = [
    r.label.padEnd(44),
    String(r.inputEvents).padStart(8),
    String(r.deliveredEvents).padStart(8),
    String(r.inputDeltas).padStart(8),
    String(r.deliveredDeltas).padStart(8),
    `${r.reductionPct.toFixed(1)}%`.padStart(8),
    `${r.wallMs.toFixed(1)}ms`.padStart(10),
    r.inputDeltaBytes === r.deliveredDeltaBytes ? 'bytes ✓' : `bytes ${r.inputDeltaBytes}→${r.deliveredDeltaBytes}`,
  ];
  return cols.join('  ');
}

function header() {
  const cols = [
    'scenario'.padEnd(44),
    'in'.padStart(8),
    'out'.padStart(8),
    'in Δ'.padStart(8),
    'out Δ'.padStart(8),
    'reduce'.padStart(8),
    'wall'.padStart(10),
    'integrity',
  ];
  return cols.join('  ');
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios = [
  {
    label: 'single project, 1 session, 500 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 1,
      tokensPerSession: 500,
    }),
  },
  {
    label: 'single project, parent + 1 subagent, 500 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 2,
      tokensPerSession: 500,
    }),
  },
  {
    label: 'single project, parent + 3 subagents, 500 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 4,
      tokensPerSession: 500,
    }),
  },
  {
    label: 'single project, parent + 9 subagents, 200 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 1,
      sessionsPerDirectory: 10,
      tokensPerSession: 200,
    }),
  },
  {
    label: '3 projects, 1 session each, 500 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 3,
      sessionsPerDirectory: 1,
      tokensPerSession: 500,
    }),
  },
  {
    label: '3 projects × (parent + subagent), 500 tokens each',
    workload: buildTokenStreamWorkload({
      directoryCount: 3,
      sessionsPerDirectory: 2,
      tokensPerSession: 500,
    }),
  },
  {
    label: '5 projects × parent + 3 subagents, 200 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 5,
      sessionsPerDirectory: 4,
      tokensPerSession: 200,
    }),
  },
  {
    label: 'stress: 10 projects × 5 sessions × 1000 tokens',
    workload: buildTokenStreamWorkload({
      directoryCount: 10,
      sessionsPerDirectory: 5,
      tokensPerSession: 1000,
    }),
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('event-pipeline synthetic benchmark\n');
  console.log(header());
  console.log('-'.repeat(header().length + 8));

  const results = [];
  for (const { label, workload } of scenarios) {
    const r = await runScenario(label, workload);
    results.push(r);
    console.log(formatRow(r));
  }

  console.log('\nLegend:');
  console.log('  in       — total events fed into the pipeline');
  console.log('  out      — total events dispatched via onEvent after coalescing + flush');
  console.log('  in Δ     — input events of type message.part.delta');
  console.log('  out Δ    — delta events that actually made it to onEvent (after merging)');
  console.log('  reduce   — (1 − outΔ / inΔ) × 100, i.e. how much delta traffic shrunk');
  console.log('  wall     — total wall-clock time for the scenario (bounded by 200ms wait)');
  console.log('  integrity — "bytes ✓" means the concatenated delta bytes match the input total');
  console.log('');
  console.log('Interpretation:');
  console.log('  Higher reduce % = fewer reducer invocations, fewer React setState calls,');
  console.log('  fewer allocations inside the flush loop. The integrity check confirms no');
  console.log('  text was dropped during coalescing.');
}

main().catch((error) => {
  console.error('benchmark failed:', error);
  process.exit(1);
});
