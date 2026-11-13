import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLinkGate } from './session-link-gate.mjs';

const FALLBACK_MS = 10_000;

const withGate = (run) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let fallbacks = 0;
    const gate = createSessionLinkGate({ fallbackMs: FALLBACK_MS, onFallback: () => { fallbacks += 1; } });
    run(gate, () => fallbacks);
  } finally {
    mock.timers.reset();
  }
};

test('a document that finished loading is not listening until it asks', () => {
  withGate((gate, fallbacks) => {
    gate.applicationDocumentLoaded();
    assert.equal(gate.isListening(), false);
    gate.documentAsked();
    assert.equal(gate.isListening(), true);
    mock.timers.tick(FALLBACK_MS);
    assert.equal(fallbacks(), 0);
  });
});

test('a document that never asks counts as listening after the fallback delay', () => {
  withGate((gate, fallbacks) => {
    gate.applicationDocumentLoaded();
    mock.timers.tick(FALLBACK_MS - 1);
    assert.equal(gate.isListening(), false);
    mock.timers.tick(1);
    assert.equal(gate.isListening(), true);
    assert.equal(fallbacks(), 1);
  });
});

test('a replaced document stops listening and its fallback never fires', () => {
  withGate((gate, fallbacks) => {
    gate.applicationDocumentLoaded();
    gate.documentReplaced();
    mock.timers.tick(FALLBACK_MS);
    assert.equal(gate.isListening(), false);
    assert.equal(fallbacks(), 0);

    gate.documentAsked();
    gate.documentReplaced();
    assert.equal(gate.isListening(), false);
  });
});

test('a document that loaded after asking keeps listening without a fallback', () => {
  withGate((gate, fallbacks) => {
    gate.documentAsked();
    gate.applicationDocumentLoaded();
    mock.timers.tick(FALLBACK_MS);
    assert.equal(gate.isListening(), true);
    assert.equal(fallbacks(), 0);
  });
});
